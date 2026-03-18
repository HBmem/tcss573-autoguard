import os
import json
import time
import boto3
from botocore.exceptions import BotoCoreError, ClientError

S3_BUCKET = "tcss573-autoguard"
S3_REGION = "us-east-2"
BASE_DIR = "/home/pi/autoguard"
IMAGE_DIR = f"{BASE_DIR}/images"
VIDEO_DIR = f"{BASE_DIR}/videos"
MEDIA_QUEUE_DIR = f"{BASE_DIR}/queue/media"
EVENT_QUEUE_DIR = f"{BASE_DIR}/queue/events"
WATCH_INTERVAL = 5  # seconds

os.makedirs(MEDIA_QUEUE_DIR, exist_ok=True)
os.makedirs(EVENT_QUEUE_DIR, exist_ok=True)

def get_s3():
    return boto3.client(
        "s3",
        region_name=S3_REGION,
        aws_access_key_id="your-aws-access-key-id",
        aws_secret_access_key="your-aws-secret-access-key"
    )

def s3_url(s3_key):
    return f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{s3_key}"

def queue_media(local_path, s3_key, media_type, intrusion_id):
    job = {
        "local_path": local_path,
        "s3_key": s3_key,
        "media_type": media_type,
        "intrusion_id": intrusion_id,
        "queued_at": int(time.time())
    }
    job_path = os.path.join(MEDIA_QUEUE_DIR, f"{intrusion_id}_{media_type}.json")
    with open(job_path, "w") as f:
        json.dump(job, f)
    print(f"Queued for later upload: {job_path}")

def try_upload(local_path, s3_key, media_type, intrusion_id):
    try:
        get_s3().upload_file(local_path, S3_BUCKET, s3_key)
        os.remove(local_path)
        print(f"Uploaded and removed local file: {s3_url(s3_key)}")
        return True
    except (BotoCoreError, ClientError) as e:
        print(f"Upload failed, queuing {local_path}: {e}")
        queue_media(local_path, s3_key, media_type, intrusion_id)
        return False

def scan_and_upload():
    # Upload new images
    for filename in os.listdir(IMAGE_DIR):
        if not filename.endswith(".jpg"):
            continue
        local_path = os.path.join(IMAGE_DIR, filename)
        intrusion_id = filename.replace(".jpg", "")
        s3_key = f"images/{filename}"
        try_upload(local_path, s3_key, "image", intrusion_id)

    # Upload new videos (only completed mp4, not h264 still being recorded)
    for filename in os.listdir(VIDEO_DIR):
        if not filename.endswith(".mp4"):
            continue
        local_path = os.path.join(VIDEO_DIR, filename)
        intrusion_id = filename.replace(".mp4", "")

        # Skip if still being written (file modified in last 5 seconds)
        if time.time() - os.path.getmtime(local_path) < 5:
            continue

        s3_key = f"videos/{filename}"
        try_upload(local_path, s3_key, "video", intrusion_id)

if __name__ == "__main__":
    print("Upload service started.")
    while True:
        try:
            scan_and_upload()
        except Exception as e:
            print(f"Scan error: {e}")
        time.sleep(WATCH_INTERVAL)

