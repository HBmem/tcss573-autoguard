import json
import urllib.request
import boto3

INFLUX_URL = "your-influxdb-url"  # e.g., "https://us-east-1-1.aws.cloud2.influxdata.com"
INFLUX_TOKEN = "your-influxdb-token"
INFLUX_ORG = "your-influxdb-org"
INFLUX_BUCKET = "your-influxdb-bucket"


s3 = boto3.client("s3", region_name="us-east-2")
S3_BUCKET = "tcss573-autoguard"
URL_EXPIRY = 3600  # 1 hour

def run_query(flux_query):
    url = f"{INFLUX_URL}/api/v2/query?org={INFLUX_ORG}"
    data = json.dumps({"query": flux_query, "type": "flux"}).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Token {INFLUX_TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/csv"
        }
    )
    try:
        with urllib.request.urlopen(req) as response:
            return response.read().decode()
    except urllib.error.HTTPError as e:
        # Print the actual error body from InfluxDB
        error_body = e.read().decode()
        raise Exception(f"InfluxDB error {e.code}: {error_body}")

def parse_csv(csv_text):
    lines = [l for l in csv_text.strip().split("\n") if l and not l.startswith("#")]
    if len(lines) < 2:
        return []
    headers = lines[0].split(",")
    rows = []
    for line in lines[1:]:
        values = line.split(",")
        rows.append(dict(zip(headers, values)))
    return rows

def lambda_handler(event, context):
    path = event.get("rawPath", "")
    headers = {"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}

    try:
        if path == "/events":
            csv = run_query(f'''
                from(bucket: "{INFLUX_BUCKET}")
                  |> range(start: -30d)
                  |> filter(fn: (r) => r["_measurement"] == "security_events")
                  |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
                  |> sort(columns: ["_time"], desc: true)
                  |> limit(n: 50)
            ''')
            rows = parse_csv(csv)
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"ok": True, "rows": rows})
            }

        elif path == "/climate-history":
            csv = run_query(f'''
                from(bucket: "{INFLUX_BUCKET}")
                  |> range(start: -24h)
                  |> filter(fn: (r) => r["_measurement"] == "vehicle_climate")
                  |> filter(fn: (r) => r["_field"] == "temperatureC" or r["_field"] == "humidity")
                  |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
                  |> sort(columns: ["_time"], desc: false)
            ''')
            rows = parse_csv(csv)
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"ok": True, "rows": rows})
            }

        elif path == "/media":
            params = event.get("queryStringParameters") or {}
            intrusion_id = params.get("intrusionId")
            media_type = params.get("type")  # 'image' or 'video'

            if not intrusion_id or not media_type:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"ok": False, "error": "Missing intrusionId or type"})
                }

            ext = "jpg" if media_type == "image" else "mp4"
            folder = "images" if media_type == "image" else "videos"
            s3_key = f"{folder}/{intrusion_id}.{ext}"

            try:
                url = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": S3_BUCKET, "Key": s3_key},
                    ExpiresIn=URL_EXPIRY
                )
                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({"ok": True, "url": url})
                }
            except (BotoCoreError, ClientError) as e:
                return {
                    "statusCode": 500,
                    "headers": headers,
                    "body": json.dumps({"ok": False, "error": str(e)})
                }

        else:
            return {
                "statusCode": 404,
                "headers": headers,
                "body": json.dumps({"ok": False, "error": "Unknown endpoint"})
            }

    except Exception as e:
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"ok": False, "error": str(e)})
        }