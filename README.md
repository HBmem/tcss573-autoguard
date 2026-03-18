# tcss573-autoguard
AutoGuard is a local-only smart car window break-in detection system using Internet of Things (IoT) technologies.

# Platforms & Dependencies

## Hardware

| Component | Details |
|---|---|
| Raspberry Pi | (Pi 1 — core logic; Pi 2 — vibration/accelerometer) |
| GrovePi+ | Sensor hat for Raspberry Pi |
| DHT11 | Temperature & humidity sensor (Pin D7) |
| Ultrasonic Ranger | Driver seat occupancy detection (Pin D5) |
| Vibration Sensor | Window vibration detection (Pi 2) |
| Accelerometer | Door acceleration detection (Pi 2) |
| Buzzer | Alarm output (Pin D3) |
| LED | Alarm indicator (Pin D4) |
| Raspberry Pi Camera | Image and video capture |

## Node-RED

### Install required Node-RED packages
node-red-contrib-grovepi 

node-red-dashboard 

node-red-contrib-influxdb 

## Python Dependencies

```bash
pip3 install boto3 
pip3 install awscli
pip3 install influxdb-client
```

## System Utilities

```bash
sudo apt install ffmpeg -y
```

# Cloud Services

| Service | Purpose |
|---|---|
| AWS Timestream | Time-series storage for climate and security events |
| AWS S3 | Stores captured images and videos |
| AWS Lambda | Pre-signed URL generation and InfluxDB \& S3 query proxy |
| AWS API Gateway | Exposes Lambda as REST endpoints to the dashboard |

---


# Deployment Layer Summary

```
Edge (Raspberry Pi)
├── All sensor reading and normalisation
├── Security state machine (active / suspicious / alarm / resolved)
├── Camera command generation
├── MQTT publish/subscribe
└── Local event and media queuing

Cloud (AWS)
├── InfluxDB — time-series persistence
├── S3 — image and video storage
└── Lambda + API Gateway — dashboard data access
```

---

# API Keys & Configuration


## AWS Credentials

Put AWS access keys, InfluxDB URL and S3 Bucket information under `upload_service.py` and `sync_service.py`. 


## InfluxDB Token

Set the InfluxDB connection details as environment variables in Node-RED's `settings.js`:

```bash
nano ~/.node-red/settings.js
```

Add the following before `module.exports`:

```javascript
process.env.INFLUX_URL     = "http://your-influxDB-ip:8086";
process.env.INFLUX_TOKEN   = "your-influxdb-api-token";
process.env.INFLUX_ORG     = "your-org-name";
process.env.INFLUX_BUCKET  = "iot-influxDB";
```

Or input those information on node-red's InfluxDB node. 


## Dashboard Configuration

In `cloud dashboard/js/dashboard.js`, set the following constants at the top of the file. Replace placeholder values — do not commit real keys:

```javascript
const API_BASE_URL   = "http://<pi-local-ip>:1880/api";
const CLOUD_API_URL  = "https://<api-gateway-id>.execute-api.us-east-1.amazonaws.com";
```

## Lambda Environment Variables

Set the following in AWS Console → Lambda → `autoguard-query` → **Configuration** → **Environment variables**:

| Key | Value |
|---|---|
| `INFLUX_URL` | `http://your-ec2-ip:8086` |
| `INFLUX_TOKEN` | your InfluxDB API token |
| `INFLUX_ORG` | your InfluxDB org name |
| `INFLUX_BUCKET` | `iot-influxDB` |
| `S3_BUCKET` | your S3 bucket name |

Reference them in Lambda code as `os.environ["INFLUX_TOKEN"]`. 

---

## Folder Structure

```
~/.node-red/                        # Node-RED home directory
├── flows.json                      # Main Node-RED flow (autoguard.json imported here)
├── settings.js                     # Node-RED config — environment variables set here
│
├── camera_service.py               # Captures images and records video via raspistill/raspivid
├── upload_service.py               # Watches for new media/events and uploads to AWS
├── sync_service.py                 # Retries failed uploads from the queue directory
├── queue_db.py                     # (Optional) SQLite helper — replaced by file-based queue
│
└── autoguard.json                  # Exportable flow file for import/backup

/home/pi/autoguard/                 # Runtime data directory
├── images/                         # Captured still images (*.jpg) — deleted after S3 upload
├── videos/                         # Recorded videos (*.h264 during recording, *.mp4 after conversion)
│
└── queue/
    ├── media/                      # Failed S3 upload job files (*.json)
    └── events/                     # Failed InfluxDB write event files (*.json)

Dashboard:
├── index.html                      # Main dashboard HTML
├── css/
│   └── dashboard.css               # Dashboard styles
└── js/
    └── dashboard.js                # Dashboard logic — API calls, charts, event rendering
```

---

# Running Node-RED Flows & Dashboard

Import the flow, make sure python scripts is under `home/pi/autoguard`, and run:
```shell
node-red-start
```

## First-Time Setup Checklist

Verify camera works
```bash
raspistill -o /home/pi/autoguard/images/test.jpg -n -t 1
```

## Accessing the Dashboard
Open `index.html` directly. Ensure `API_BASE_URL` in `dashboard.js` points to the Pi's current IP.
To access cloud dashboard, simply open `cloud dashboard/index.html`.

## Arming the System

From the dashboard, click **Arm Vehicle**. This triggers the baseline capture — the ultrasonic sensor records the current seat distance as the reference point. The system state changes from `Inactive` to `Active`.