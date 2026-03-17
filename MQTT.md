# MQTT Setup

## Install the MQTT broker on the broker Pi

Install Mosquitto

```bash
sudo apt update
sudo apt install mosquitto mosquitto-clients -y
```

Then enable and start it:
```bash
sudo systemctl enable mosquitto
sudo systemctl start mosquitto
```

check that it is running

```bash
sudo systemctl status mosquitto
```

