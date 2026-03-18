import os
import json
import time
import boto3
import influxdb_client
from influxdb_client.client.write_api import SYNCHRONOUS
from botocore.exceptions import BotoCoreError, ClientError

S3_BUCKET = "your-s3-bucket-name"
S3_REGION = "us-east-2"
BASE_DIR = "/home/pi/autoguard"
MEDIA_QUEUE_DIR = f"{BASE_DIR}/queue/media"
EVENT_QUEUE_DIR = f"{BASE_DIR}/queue/events"
RETRY_INTERVAL = 30

def get_s3():
    return boto3.client(
        "s3",
        region_name=S3_REGION,
        aws_access_key_id="your-aws-access-key-id",
        aws_secret_access_key="your-aws-secret-access-key"
    )

def s3_url(s3_key):
    return f"https://{S3_BUCKET}.s3.{S3_REGION}.amazonaws.com/{s3_key}"

def sync_media():
    jobs = [f for f in os.listdir(MEDIA_QUEUE_DIR) if f.endswith(".json")]
    if not jobs:
        return

    print(f"Found {len(jobs)} pending media upload(s).")
    s3 = get_s3()

    for job_file in jobs:
        job_path = os.path.join(MEDIA_QUEUE_DIR, job_file)
        try:
            with open(job_path) as f:
                job = json.load(f)

            local_path = job["local_path"]
            s3_key = job["s3_key"]

            if not os.path.exists(local_path):
                print(f"Local file missing, removing job: {local_path}")
                os.remove(job_path)
                continue

            s3.upload_file(local_path, S3_BUCKET, s3_key)
            os.remove(local_path)
            os.remove(job_path)
            print(f"Synced and cleaned up: {s3_url(s3_key)}")

        except (BotoCoreError, ClientError) as e:
            print(f"S3 still unavailable for {job_file}: {e}")
        except Exception as e:
            print(f"Unexpected error for {job_file}: {e}")

def sync_events():
    jobs = [f for f in os.listdir(EVENT_QUEUE_DIR) if f.endswith(".json")]
    if not jobs:
        return

    print(f"Found {len(jobs)} pending event(s).")
    client = influxdb_client.InfluxDBClient(
        url="https://efeilr8eqm-sngx6nimmoesju.timestream-influxdb.us-east-2.on.aws:8086",
        token="skaiDcUw-OErlQJtR62cBYf4NutzBZG3hDErvvg9QKycISe5oY4IvZHOtTu0liaHfSPdkFX1CzsDqHLKZVXpog==",
        org="tcss573"
    )
    write_api = client.write_api(write_options=SYNCHRONOUS)

    for job_file in sorted(jobs):  # oldest first
        job_path = os.path.join(EVENT_QUEUE_DIR, job_file)
        try:
            with open(job_path) as f:
                job = json.load(f)

            point = influxdb_client.Point(job["measurement"])
            for k, v in job.get("tags", {}).items():
                point.tag(k, v)
            for k, v in job.get("fields", {}).items():
                if v is not None:
                    point.field(k, v)
            point.time(job["timestamp"], write_precision="ms")

            write_api.write(bucket="iot-influxDB", record=point)
            os.remove(job_path)
            print(f"Synced event: {job['measurement']} at {job['timestamp']}")

        except Exception as e:
            print(f"InfluxDB still unavailable for {job_file}: {e}")

    client.close()

if __name__ == "__main__":
    print("Sync service started.")
    while True:
        try:
            sync_media()
            sync_events()
        except Exception as e:
            print(f"Sync cycle error: {e}")
        time.sleep(RETRY_INTERVAL)

