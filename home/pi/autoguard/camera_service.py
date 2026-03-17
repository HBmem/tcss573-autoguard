#!/usr/bin/env python3
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from picamera import PiCamera


def ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def capture_image(output: str, warmup: float = 2.0, resolution=(1280, 720)) -> dict:
    ensure_parent_dir(output)

    camera = PiCamera()
    try:
        camera.resolution = resolution
        camera.start_preview()
        time.sleep(warmup)
        camera.capture(output)
    finally:
        camera.close()

    return {
        "ok": True,
        "action": "capture-image",
        "output": output,
        "ts": int(time.time() * 1000)
    }


def start_video(output: str, pid_file: str, warmup: float = 1.0, resolution=(1280, 720), framerate: int = 24) -> dict:
    ensure_parent_dir(output)
    ensure_parent_dir(pid_file)

    camera = PiCamera()
    try:
        camera.resolution = resolution
        camera.framerate = framerate
        camera.start_preview()
        time.sleep(warmup)
        camera.start_recording(output)

        with open(pid_file, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))

        running = True

        def handle_stop(signum, frame):
            nonlocal running
            running = False

        signal.signal(signal.SIGTERM, handle_stop)
        signal.signal(signal.SIGINT, handle_stop)

        while running:
            camera.wait_recording(1)

        camera.stop_recording()

    finally:
        if os.path.exists(pid_file):
            os.remove(pid_file)
        camera.close()

    return {
        "ok": True,
        "action": "start-video-ended",
        "output": output,
        "ts": int(time.time() * 1000)
    }


def remux_h264_to_mp4(h264_input: str, mp4_output: str, framerate: int = 24) -> dict:
    ensure_parent_dir(mp4_output)

    if not os.path.exists(h264_input):
        return {
            "ok": False,
            "action": "remux",
            "error": "H264 input file not found",
            "input": h264_input,
            "output": mp4_output,
            "ts": int(time.time() * 1000)
        }

    cmd = [
        "ffmpeg",
        "-y",
        "-framerate", str(framerate),
        "-i", h264_input,
        "-c:v", "copy",
        mp4_output
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        return {
            "ok": False,
            "action": "remux",
            "error": result.stderr.strip() or "ffmpeg conversion failed",
            "input": h264_input,
            "output": mp4_output,
            "ts": int(time.time() * 1000)
        }

    return {
        "ok": True,
        "action": "remux",
        "input": h264_input,
        "output": mp4_output,
        "ts": int(time.time() * 1000)
    }


def stop_video(pid_file: str, h264_input: str = "", mp4_output: str = "") -> dict:
    pid = None
    killed = False

    if os.path.exists(pid_file):
        with open(pid_file, "r", encoding="utf-8") as f:
            pid_text = f.read().strip()

        if pid_text.isdigit():
            pid = int(pid_text)
            try:
                os.kill(pid, signal.SIGTERM)
                killed = True
            except ProcessLookupError:
                killed = False

    time.sleep(3)

    remux_result = None
    if h264_input and mp4_output:
        remux_result = remux_h264_to_mp4(h264_input, mp4_output)

    ok = True if remux_result is None else remux_result.get("ok", False)

    return {
        "ok": ok,
        "action": "stop-video",
        "pidFile": pid_file,
        "pid": pid,
        "killed": killed,
        "h264Input": h264_input,
        "mp4Output": mp4_output,
        "remux": remux_result,
        "ts": int(time.time() * 1000)
    }


def main():
    parser = argparse.ArgumentParser(description="AutoGuard PiCamera service")
    subparsers = parser.add_subparsers(dest="action", required=True)

    image_parser = subparsers.add_parser("capture-image", help="Capture a single image")
    image_parser.add_argument("--output", required=True, help="Path to output image file")
    image_parser.add_argument("--warmup", type=float, default=2.0, help="Camera warmup time in seconds")

    start_parser = subparsers.add_parser("start-video", help="Start a long-running video recording")
    start_parser.add_argument("--output", required=True, help="Path to output H264 video file")
    start_parser.add_argument("--pid-file", required=True, help="Path to PID file")
    start_parser.add_argument("--warmup", type=float, default=1.0, help="Camera warmup time in seconds")
    start_parser.add_argument("--framerate", type=int, default=24, help="Camera framerate")

    stop_parser = subparsers.add_parser("stop-video", help="Stop a running video recording")
    stop_parser.add_argument("--pid-file", required=True, help="Path to PID file")
    stop_parser.add_argument("--h264-input", default="", help="Path to input H264 file")
    stop_parser.add_argument("--mp4-output", default="", help="Path to output MP4 file")

    args = parser.parse_args()

    try:
        if args.action == "capture-image":
            result = capture_image(
                output=args.output,
                warmup=args.warmup
            )
        elif args.action == "start-video":
            result = start_video(
                output=args.output,
                pid_file=args.pid_file,
                warmup=args.warmup,
                framerate=args.framerate
            )
        elif args.action == "stop-video":
            result = stop_video(
                pid_file=args.pid_file,
                h264_input=args.h264_input,
                mp4_output=args.mp4_output
            )
        else:
            result = {
                "ok": False,
                "error": f"Unsupported action: {args.action}",
                "ts": int(time.time() * 1000)
            }

        print(json.dumps(result))
        sys.exit(0 if result.get("ok") else 1)

    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": str(exc),
            "action": args.action,
            "ts": int(time.time() * 1000)
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
