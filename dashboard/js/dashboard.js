const API_BASE_URL = 'https://10.0.0.203:1880/api';
// const API_BASE_URL = 'https://10.19.73.166:1880/api';

const HTTP_ROOT = API_BASE_URL.replace(/\/api$/, '');
const MEDIA_ROOT = `${HTTP_ROOT}/media`;

let isArmed = false;
let currentState = 'inactive';
let currentStatus = null;
let currentSettings = null;
let liveFeedEvents = [];
let suspiciousModalInstance = null;
let activePromptIntrusionId = null;
let suspiciousActionInProgress = false;
let historySelectionId = null;
let selectedIntrusionId = null;
let metricsViewMode = 'current';
let distanceBaseline = null;
let previousVibration = null;

const chartHistory = {
    temperature: [],
    humidity: [],
    distance: [],
    acceleration: [],
    vibration: []
};

google.charts.load('current', { packages: ['corechart', 'gauge'] });
google.charts.setOnLoadCallback(() => {
    drawAllMetricCharts();
});

function qs(id) {
    return document.getElementById(id);
}

function safeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function formatMetricNumber(value, digits = 1) {
    const num = safeNumber(value);
    return num === null ? '--' : num.toFixed(digits);
}

function getDistanceDirectionInfo(current, baseline) {
    if (current === null || baseline === null) {
        return {
            text: 'Waiting for baseline',
            className: 'text-bg-secondary',
            deltaText: '--'
        };
    }

    const delta = current - baseline;

    if (Math.abs(delta) < 0.5) {
        return {
            text: 'At Baseline Distance',
            className: 'text-bg-info',
            deltaText: `${delta.toFixed(1)} cm`
        };
    }

    if (delta > 0) {
        return {
            text: 'Farther Than Initial',
            className: 'text-bg-warning',
            deltaText: `+${delta.toFixed(1)} cm`
        };
    }

    return {
        text: 'Closer Than Initial',
        className: 'text-bg-success',
        deltaText: `${delta.toFixed(1)} cm`
    };
}

function getAccelerationDirection(x, y) {
    const ax = safeNumber(x);
    const ay = safeNumber(y);

    if (ax === null || ay === null) {
        return {
            label: 'Direction Unknown',
            arrow: '•',
            badgeClass: 'text-bg-secondary'
        };
    }

    if (Math.abs(ax) < 0.05 && Math.abs(ay) < 0.05) {
        return {
            label: 'Minimal Movement',
            arrow: '•',
            badgeClass: 'text-bg-info'
        };
    }

    if (Math.abs(ax) >= Math.abs(ay)) {
        if (ax > 0) {
            return {
                label: 'Rightward Movement',
                arrow: '→',
                badgeClass: 'text-bg-warning'
            };
        }

        return {
            label: 'Leftward Movement',
            arrow: '←',
            badgeClass: 'text-bg-warning'
        };
    }

    if (ay > 0) {
        return {
            label: 'Forward / Upward Movement',
            arrow: '↑',
            badgeClass: 'text-bg-danger'
        };
    }

    return {
        label: 'Backward / Downward Movement',
        arrow: '↓',
        badgeClass: 'text-bg-danger'
    };
}

function getVibrationChangeInfo(current, previous) {
    if (current === null) {
        return {
            stateText: 'No Data',
            stateClass: 'text-bg-secondary',
            deltaText: '--'
        };
    }

    if (previous === null) {
        return {
            stateText: 'Baseline Captured',
            stateClass: 'text-bg-info',
            deltaText: '--'
        };
    }

    const delta = current - previous;

    if (Math.abs(delta) < 0.05) {
        return {
            stateText: 'Stable',
            stateClass: 'text-bg-success',
            deltaText: delta.toFixed(2)
        };
    }

    if (delta > 0) {
        return {
            stateText: 'Vibration Increased',
            stateClass: 'text-bg-danger',
            deltaText: `+${delta.toFixed(2)}`
        };
    }

    return {
        stateText: 'Vibration Decreased',
        stateClass: 'text-bg-warning',
        deltaText: delta.toFixed(2)
    };
}

function addHistoryPoint(series, value, ts) {
    if (value === null) return;

    series.push([new Date(ts || Date.now()), value]);

    if (series.length > 40) {
        series.shift();
    }
}

function formatDateTime(ts) {
    if (!ts) return '--';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString();
}

function formatSensorName(sensor) {
    const names = {
        ultrasonic: 'Driver Seat Occupancy',
        vibration: 'Window Vibration',
        accel: 'Door Acceleration',
        accelerometer: 'Door Acceleration',
        dashboard_confirmed: 'Dashboard Confirmation'
    };

    return names[sensor] || sensor;
}

function buildSensorBadges(evidence = []) {
    if (!Array.isArray(evidence) || evidence.length === 0) {
        return '<span class="badge text-bg-secondary">Unknown</span>';
    }

    return evidence.map(sensor => {
        return `<span class="badge text-bg-warning text-dark">${formatSensorName(sensor)}</span>`;
    }).join('');
}

function buildMediaUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';

    const filename = filePath.split('/').pop();
    if (!filename) return '';

    if (filePath.includes('/images/')) {
        return `${MEDIA_ROOT}/images/${filename}`;
    }

    if (filePath.includes('/videos/')) {
        return `${MEDIA_ROOT}/videos/${filename}`;
    }

    return '';
}

function getStateBadgeClass(state) {
    switch (state) {
        case 'active':
            return 'text-bg-success';
        case 'suspicious':
            return 'text-bg-warning';
        case 'alarm':
            return 'text-bg-danger';
        case 'resolved':
            return 'text-bg-info';
        default:
            return 'text-bg-secondary';
    }
}

function setSystemStateBadge(state) {
    const badge = qs('systemStateBadge');
    badge.className = `badge status-chip ${getStateBadgeClass(state)}`;
    badge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function showToastMessage(message) {
    console.log(message);
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data?.error || data?.message || `Request failed with status ${response.status}`);
    }

    return data;
}

function updateActionButtons() {
    const armBtn = qs('armStatusBtn');
    const resolveBtn = qs('cancelAlarmBtn');

    armBtn.textContent = isArmed ? 'Disarm Vehicle' : 'Arm Vehicle';
    armBtn.classList.toggle('btn-primary', !isArmed);
    armBtn.classList.toggle('btn-danger', isArmed);

    const canResolve = currentState === 'alarm' || currentState === 'suspicious';
    resolveBtn.disabled = !canResolve;
}

function updateSensorPills(status) {
    const evidence = status?.intrusion?.confirmedBy || [];
    const armed = Boolean(status?.armed);

    const occupancySensor = qs('occupancySensor');
    const vibrationSensor = qs('vibrationSensor');
    const accelSensor = qs('accelSensor');
    const climateSensor = qs('climateSensor');

    const ultrasonicTriggered = evidence.includes('ultrasonic');
    const vibrationTriggered = evidence.includes('vibration');
    const accelTriggered = evidence.includes('accel') || evidence.includes('accelerometer');

    occupancySensor.className = 'badge status-chip';
    vibrationSensor.className = 'badge status-chip';
    accelSensor.className = 'badge status-chip';
    climateSensor.className = 'badge status-chip text-bg-info';

    if (!armed) {
        occupancySensor.classList.add('text-bg-secondary');
        vibrationSensor.classList.add('text-bg-secondary');
        accelSensor.classList.add('text-bg-secondary');

        occupancySensor.textContent = 'Occupancy Sensor Off';
        vibrationSensor.textContent = 'Window Vibration Sensor Off';
        accelSensor.textContent = 'Door Acceleration Sensor Off';
    } else {
        occupancySensor.classList.add(ultrasonicTriggered ? 'text-bg-danger' : 'text-bg-success');
        vibrationSensor.classList.add(vibrationTriggered ? 'text-bg-danger' : 'text-bg-success');
        accelSensor.classList.add(accelTriggered ? 'text-bg-danger' : 'text-bg-success');

        occupancySensor.textContent = ultrasonicTriggered ? 'Driver Seat Occupancy Detected' : 'No Driver Seat Occupancy';
        vibrationSensor.textContent = vibrationTriggered ? 'Window Vibration Detected' : 'No Window Vibration';
        accelSensor.textContent = accelTriggered ? 'Door Acceleration Detected' : 'No Door Acceleration';
    }

    climateSensor.textContent = 'Climate Monitoring Active';
}

function pushMetricHistory(status) {
    const last = status?.last || {};
    const baseline = status?.baseline || {};
    const ts = status?.ts || Date.now();

    const temperature = safeNumber(last.temperatureC);
    const humidity = safeNumber(last.humidity);
    const distance = safeNumber(last.distanceCm);
    const vibration = safeNumber(last.vibration);
    const accelMag = safeNumber(last.accelMag);

    addHistoryPoint(chartHistory.temperature, temperature, ts);
    addHistoryPoint(chartHistory.humidity, humidity, ts);
    addHistoryPoint(chartHistory.distance, distance, ts);
    addHistoryPoint(chartHistory.vibration, vibration, ts);
    addHistoryPoint(chartHistory.acceleration, accelMag, ts);

    distanceBaseline = safeNumber(baseline.distanceCm);
}

function updateMetricCards(status) {
    const last = status?.last || {};
    const baseline = status?.baseline || {};

    const temperature = safeNumber(last.temperatureC);
    const humidity = safeNumber(last.humidity);
    const distance = safeNumber(last.distanceCm);
    const vibration = safeNumber(last.vibration);
    const accelMag = safeNumber(last.accelMag);

    const accelX = safeNumber(last.accelX ?? last.x ?? last.accelerationX);
    const accelY = safeNumber(last.accelY ?? last.y ?? last.accelerationY);
    const accelZ = safeNumber(last.accelZ ?? last.z ?? last.accelerationZ);

    distanceBaseline = safeNumber(baseline.distanceCm);
    const baselineCapturedAt = baseline?.capturedAt || null;

    qs('metricTemperature').textContent = formatMetricNumber(temperature, 1);
    qs('metricHumidity').textContent = formatMetricNumber(humidity, 1);
    qs('metricDistance').textContent = formatMetricNumber(distance, 1);
    qs('metricAccel').textContent = formatMetricNumber(accelMag, 2);
    qs('metricVibration').textContent = formatMetricNumber(vibration, 2);

    qs('metricDistanceInitial').textContent = distanceBaseline === null
        ? '--'
        : `${distanceBaseline.toFixed(1)} cm`;

    qs('metricDistanceCapturedAt').textContent = baselineCapturedAt
        ? formatDateTime(baselineCapturedAt)
        : '--';

    const distanceInfo = getDistanceDirectionInfo(distance, distanceBaseline);
    qs('metricDistanceDelta').textContent = distanceInfo.deltaText;
    qs('metricDistanceDirection').className = `badge status-chip ${distanceInfo.className}`;
    qs('metricDistanceDirection').textContent = distanceInfo.text;

    const accelDirection = getAccelerationDirection(accelX, accelY);
    qs('metricAccelArrow').textContent = accelDirection.arrow;
    qs('metricAccelDirection').className = `badge status-chip ${accelDirection.badgeClass}`;
    qs('metricAccelDirection').textContent = accelDirection.label;
    qs('metricAccelVector').textContent =
        `X: ${formatMetricNumber(accelX, 2)} | Y: ${formatMetricNumber(accelY, 2)} | Z: ${formatMetricNumber(accelZ, 2)}`;

    qs('metricVibrationPrevious').textContent = previousVibration === null
        ? '--'
        : previousVibration.toFixed(2);

    const vibrationInfo = getVibrationChangeInfo(vibration, previousVibration);
    qs('metricVibrationDelta').textContent = vibrationInfo.deltaText;
    qs('metricVibrationState').className = `badge status-chip ${vibrationInfo.stateClass}`;
    qs('metricVibrationState').textContent = vibrationInfo.stateText;

    previousVibration = vibration;
}

function drawGauge(containerId, label, value, min, max, yellowFrom, yellowTo, redFrom, redTo) {
    const container = qs(containerId);
    if (!container || !google.visualization) return;

    const data = google.visualization.arrayToDataTable([
        ['Label', 'Value'],
        [label, value ?? 0]
    ]);

    const chart = new google.visualization.Gauge(container);
    chart.draw(data, {
        width: '100%',
        height: 240,
        min,
        max,
        yellowFrom,
        yellowTo,
        redFrom,
        redTo,
        minorTicks: 5
    });
}

function drawSingleTrendChart(containerId, label, series, minValue = null, maxValue = null) {
    const container = qs(containerId);
    if (!container || !google.visualization) return;

    const data = new google.visualization.DataTable();
    data.addColumn('datetime', 'Time');
    data.addColumn('number', label);

    if (series.length) {
        data.addRows(series);
    }

    const options = {
        backgroundColor: '#111827',
        chartArea: { left: 55, right: 20, top: 20, bottom: 50 },
        legend: { position: 'none' },
        hAxis: {
            textStyle: { color: '#94a3b8' },
            gridlines: { color: '#1f2937' }
        },
        vAxis: {
            textStyle: { color: '#94a3b8' },
            gridlines: { color: '#1f2937' },
            viewWindow: {
                min: minValue,
                max: maxValue
            }
        }
    };

    const chart = new google.visualization.LineChart(container);
    chart.draw(data, options);
}

function drawAllMetricCharts() {
    const last = currentStatus?.last || {};

    drawGauge(
        'temperatureGauge',
        'Temp',
        safeNumber(last.temperatureC),
        0,
        45,
        18,
        28,
        32,
        45
    );

    drawGauge(
        'humidityGauge',
        'Humidity',
        safeNumber(last.humidity),
        0,
        100,
        30,
        60,
        75,
        100
    );

    drawSingleTrendChart('temperatureTrendChart', 'Temperature (°C)', chartHistory.temperature);
    drawSingleTrendChart('humidityTrendChart', 'Humidity (%)', chartHistory.humidity, 0, 100);
    drawSingleTrendChart('distanceTrendChart', 'Distance (cm)', chartHistory.distance);
    drawSingleTrendChart('accelTrendChart', 'Acceleration', chartHistory.acceleration);
    drawSingleTrendChart('vibrationTrendChart', 'Vibration', chartHistory.vibration);
}

function groupEventsByIntrusion(events = []) {
    const groups = new Map();

    events.forEach((event, index) => {
        const key = event.intrusionId || `ungrouped-${index}`;

        if (!groups.has(key)) {
            groups.set(key, {
                intrusionId: event.intrusionId || null,
                events: [],
                firstTs: event.ts || 0,
                lastTs: event.ts || 0
            });
        }

        const group = groups.get(key);
        group.events.push(event);

        if ((event.ts || 0) < group.firstTs) group.firstTs = event.ts || 0;
        if ((event.ts || 0) > group.lastTs) group.lastTs = event.ts || 0;
    });

    return Array.from(groups.values())
        .map(group => {
            group.events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
            return group;
        })
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

function getSelectedIntrusionGroup() {
    const groups = groupEventsByIntrusion(liveFeedEvents);

    if (!groups.length) {
        return null;
    }

    if (!selectedIntrusionId) {
        selectedIntrusionId = groups[0].intrusionId || '__ungrouped__';
    }

    const selected = groups.find(group => {
        const id = group.intrusionId || '__ungrouped__';
        return id === selectedIntrusionId;
    });

    return selected || groups[0];
}

function renderIntrusionGroupList() {
    const container = qs('intrusionGroupList');
    container.innerHTML = '';

    const groups = groupEventsByIntrusion(liveFeedEvents);

    if (!groups.length) {
        container.innerHTML = `<div class="empty-state">No intrusion groups available yet.</div>`;
        return;
    }

    if (!selectedIntrusionId) {
        selectedIntrusionId = groups[0].intrusionId || '__ungrouped__';
    }

    groups.forEach(group => {
        const groupId = group.intrusionId || '__ungrouped__';
        const latestEvent = group.events[0];
        const eventCount = group.events.length;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `intrusion-group-item ${selectedIntrusionId === groupId ? 'active' : ''}`;

        button.innerHTML = `
            <div class="fw-semibold mb-1">${group.intrusionId || 'System Event'}</div>
            <div class="small-label mb-1">Latest State: ${latestEvent?.state || '--'}</div>
            <div class="small-label mb-1">Latest Reason: ${latestEvent?.reason || '--'}</div>
            <div class="small-label mb-1">Events: ${eventCount}</div>
            <div class="small-label">Last Activity: ${formatDateTime(group.lastTs)}</div>
        `;

        button.addEventListener('click', () => {
            selectedIntrusionId = groupId;
            renderIntrusionGroupList();
            renderSelectedIntrusion();
        });

        container.appendChild(button);
    });
}

function renderSelectedIntrusion() {
    const group = getSelectedIntrusionGroup();

    const cameraImage = qs('cameraImage');
    const cameraPlaceholder = qs('cameraPlaceholder');
    const openImageLink = qs('openImageLink');
    const openVideoLink = qs('openVideoLink');
    const timeline = qs('selectedIntrusionTimeline');

    if (!group) {
        qs('currentIntrusionId').textContent = '--';
        qs('currentIntrusionStartedAt').textContent = '--';
        qs('selectedIntrusionState').textContent = '--';
        qs('selectedIntrusionReason').textContent = '--';
        qs('currentIntrusionEvidence').innerHTML = '--';
        qs('currentIntrusionNote').textContent = '--';

        timeline.innerHTML = `<div class="empty-state">No intrusion selected.</div>`;

        cameraImage.src = '';
        cameraImage.style.display = 'none';
        cameraPlaceholder.style.display = 'block';
        openImageLink.classList.add('d-none');
        openVideoLink.classList.add('d-none');
        return;
    }

    const latestEvent = group.events[0];
    const earliestEvent = group.events[group.events.length - 1];

    const latestMediaEvent = group.events.find(event => event.picturePath || event.videoPath) || null;
    const imageUrl = latestMediaEvent?.picturePath ? buildMediaUrl(latestMediaEvent.picturePath) : '';
    const videoUrl = latestMediaEvent?.videoPath ? buildMediaUrl(latestMediaEvent.videoPath) : '';

    qs('currentIntrusionId').textContent = group.intrusionId || 'System Event';
    qs('currentIntrusionStartedAt').textContent = formatDateTime(earliestEvent?.ts);
    qs('selectedIntrusionState').textContent = latestEvent?.state || '--';
    qs('selectedIntrusionReason').textContent = latestEvent?.reason || '--';
    qs('currentIntrusionEvidence').innerHTML = buildSensorBadges(latestEvent?.evidence || []);
    qs('currentIntrusionNote').textContent = latestEvent?.note || '--';

    if (imageUrl) {
        cameraImage.src = imageUrl;
        cameraImage.style.display = 'block';
        cameraPlaceholder.style.display = 'none';
        openImageLink.href = imageUrl;
        openImageLink.classList.remove('d-none');
    } else {
        cameraImage.src = '';
        cameraImage.style.display = 'none';
        cameraPlaceholder.style.display = 'block';
        openImageLink.classList.add('d-none');
    }

    if (videoUrl) {
        openVideoLink.href = videoUrl;
        openVideoLink.classList.remove('d-none');
    } else {
        openVideoLink.classList.add('d-none');
    }

    timeline.innerHTML = '';

    group.events
        .slice()
        .sort((a, b) => (a.ts || 0) - (b.ts || 0))
        .forEach(event => {
            const block = document.createElement('div');
            block.className = 'event-block';

            const eventImageUrl = buildMediaUrl(event.picturePath || '');
            const eventVideoUrl = buildMediaUrl(event.videoPath || '');

            block.innerHTML = `
                <div class="d-flex justify-content-between align-items-start gap-3">
                    <div>
                        <div class="fw-semibold mb-1">${event.type || 'UNKNOWN'}</div>
                        <div class="small-label mb-1">Time: ${formatDateTime(event.ts)}</div>
                        <div class="small-label mb-1">State: ${event.state || '--'}</div>
                        <div class="small-label mb-1">Reason: ${event.reason || '--'}</div>
                        <div class="mb-2">${buildSensorBadges(event.evidence || [])}</div>
                        ${event.note ? `<div class="small-label">Note: ${event.note}</div>` : ''}
                    </div>
                    <div class="d-flex flex-column gap-2">
                        ${eventImageUrl ? `<a class="btn btn-sm btn-outline-light" href="${eventImageUrl}" target="_blank" rel="noopener noreferrer">Image</a>` : ''}
                        ${eventVideoUrl ? `<a class="btn btn-sm btn-outline-warning" href="${eventVideoUrl}" target="_blank" rel="noopener noreferrer">Video</a>` : ''}
                    </div>
                </div>
            `;

            timeline.appendChild(block);
        });
}

function renderHistoryList() {
    const historyList = qs('historyList');
    historyList.innerHTML = '';

    if (!liveFeedEvents.length) {
        historyList.innerHTML = `<div class="empty-state">No event history available yet.</div>`;
        qs('historyDetails').innerHTML = 'Select an event to view its details.';
        return;
    }

    liveFeedEvents.forEach((event, index) => {
        const id = `${event.intrusionId || 'event'}-${event.ts || index}`;
        const btn = document.createElement('button');
        btn.className = `btn text-start history-item ${historySelectionId === id ? 'active' : ''}`;
        btn.type = 'button';

        btn.innerHTML = `
            <div class="fw-semibold">${event.type || 'UNKNOWN'}</div>
            <div class="small-label">${formatDateTime(event.ts)}</div>
            <div class="small-label">${event.reason || '--'}</div>
        `;

        btn.addEventListener('click', () => {
            historySelectionId = id;
            renderHistoryList();
            renderHistoryDetails(event);
        });

        historyList.appendChild(btn);

        if (!historySelectionId && index === 0) {
            historySelectionId = id;
            renderHistoryDetails(event);
        }
    });
}

function renderHistoryDetails(event) {
    const historyDetails = qs('historyDetails');

    if (!event) {
        historyDetails.innerHTML = 'Select an event to view its details.';
        return;
    }

    const imageUrl = buildMediaUrl(event.picturePath || '');
    const videoUrl = buildMediaUrl(event.videoPath || '');

    historyDetails.innerHTML = `
        <div class="mb-3">
            <div class="small-label">Type</div>
            <div>${event.type || '--'}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">Reason</div>
            <div>${event.reason || '--'}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">State</div>
            <div>${event.state || '--'}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">Time</div>
            <div>${formatDateTime(event.ts)}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">Intrusion ID</div>
            <div>${event.intrusionId || '--'}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">Evidence</div>
            <div>${buildSensorBadges(event.evidence || [])}</div>
        </div>
        <div class="mb-3">
            <div class="small-label">Note</div>
            <div>${event.note || '--'}</div>
        </div>
        <div class="d-flex gap-2 flex-wrap">
            ${imageUrl ? `<a class="btn btn-outline-light" href="${imageUrl}" target="_blank" rel="noopener noreferrer">Open Image</a>` : ''}
            ${videoUrl ? `<a class="btn btn-outline-warning" href="${videoUrl}" target="_blank" rel="noopener noreferrer">Open Video</a>` : ''}
        </div>
    `;
}

function showSuspiciousActivityModal(intrusion) {
    if (!intrusion || !intrusion.id) return;

    const modalEl = qs('suspiciousActivityModal');
    if (!modalEl) return;

    if (!suspiciousModalInstance) {
        suspiciousModalInstance = new bootstrap.Modal(modalEl, {
            backdrop: 'static',
            keyboard: false
        });
    }

    activePromptIntrusionId = intrusion.id;

    qs('suspiciousSummary').innerText =
        'AutoGuard detected low-level suspicious activity. Confirm whether this was caused by you or escalate to a full alarm.';

    qs('suspiciousSensorBadges').innerHTML = buildSensorBadges(intrusion.confirmedBy || []);
    qs('suspiciousStartedAt').innerText = formatDateTime(intrusion.startedAt);

    suspiciousModalInstance.show();
}

function hideSuspiciousActivityModal() {
    if (suspiciousModalInstance) {
        suspiciousModalInstance.hide();
    }

    activePromptIntrusionId = null;
    const noteEl = qs('suspiciousUserNote');
    if (noteEl) {
        noteEl.value = '';
    }
}

function handleSuspiciousActivityPrompt(status) {
    if (suspiciousActionInProgress) {
        return;
    }

    if (!status || !status.intrusion) {
        hideSuspiciousActivityModal();
        return;
    }

    const intrusion = status.intrusion;

    if (status.armed === true && status.state === 'suspicious' && intrusion.id) {
        if (activePromptIntrusionId !== intrusion.id) {
            showSuspiciousActivityModal(intrusion);
        }
        return;
    }

    if (status.state !== 'suspicious') {
        hideSuspiciousActivityModal();
    }
}

async function getStatus() {
    try {
        const data = await fetchJson(`${API_BASE_URL}/status`);
        currentStatus = data;
        isArmed = Boolean(data.armed);
        currentState = data.state || 'inactive';

        setSystemStateBadge(currentState);
        updateActionButtons();
        updateSensorPills(data);
        pushMetricHistory(data);
        updateMetricCards(data);
        drawAllMetricCharts();
        handleSuspiciousActivityPrompt(data);
    } catch (error) {
        console.error('Error fetching status:', error);
        showToastMessage(error.message);
    }
}

async function getLiveFeed() {
    try {
        const data = await fetchJson(`${API_BASE_URL}/live-feed`);
        liveFeedEvents = Array.isArray(data.events) ? data.events : [];

        const grouped = groupEventsByIntrusion(liveFeedEvents);
        if (grouped.length && !grouped.some(group => (group.intrusionId || '__ungrouped__') === selectedIntrusionId)) {
            selectedIntrusionId = grouped[0].intrusionId || '__ungrouped__';
        }

        renderIntrusionGroupList();
        renderSelectedIntrusion();
        renderHistoryList();
    } catch (error) {
        console.error('Error fetching live feed:', error);
    }
}

async function getSettings() {
    try {
        const data = await fetchJson(`${API_BASE_URL}/settings`);
        currentSettings = data.settings || {};
        populateSettingsForm(currentSettings);
    } catch (error) {
        console.error('Error fetching settings:', error);
    }
}

function populateSettingsForm(settings = {}) {
    qs('suspiciousModeEnabled').value = String(Boolean(settings.suspiciousModeEnabled));
    qs('seatDeltaCm').value = settings.seatDeltaCm ?? '';
    qs('seatDebounceMs').value = settings.seatDebounceMs ?? '';
    qs('vibrationSpike').value = settings.vibrationSpike ?? '';
    qs('accelMagSpike').value = settings.accelMagSpike ?? '';
    qs('confirmWindowMs').value = settings.confirmWindowMs ?? '';
    qs('suspiciousTimeoutMs').value = settings.suspiciousTimeoutMs ?? '';
    qs('alarmMinMs').value = settings.alarmMinMs ?? '';
    qs('autoResolveQuietMs').value = settings.autoResolveQuietMs ?? '';
    qs('notificationPhone').value = settings.notificationPhone ?? '';
    qs('notificationEmail').value = settings.notificationEmail ?? '';
}

async function saveSettings() {
    const payload = {
        suspiciousModeEnabled: qs('suspiciousModeEnabled').value === 'true',
        seatDeltaCm: Number(qs('seatDeltaCm').value),
        seatDebounceMs: Number(qs('seatDebounceMs').value),
        vibrationSpike: Number(qs('vibrationSpike').value),
        accelMagSpike: Number(qs('accelMagSpike').value),
        confirmWindowMs: Number(qs('confirmWindowMs').value),
        suspiciousTimeoutMs: Number(qs('suspiciousTimeoutMs').value),
        alarmMinMs: Number(qs('alarmMinMs').value),
        autoResolveQuietMs: Number(qs('autoResolveQuietMs').value),
        notificationPhone: qs('notificationPhone').value.trim(),
        notificationEmail: qs('notificationEmail').value.trim()
    };

    try {
        const data = await fetchJson(`${API_BASE_URL}/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        currentSettings = data.settings || payload;
        showToastMessage('Settings saved successfully.');
    } catch (error) {
        console.error('Error saving settings:', error);
        alert(error.message);
    }
}

async function armSystem() {
    try {
        await fetchJson(`${API_BASE_URL}/arm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ armed: true })
        });

        await getStatus();
        await getLiveFeed();
    } catch (error) {
        console.error('Error arming system:', error);
        alert(error.message);
    }
}

async function disarmSystem() {
    try {
        await fetchJson(`${API_BASE_URL}/arm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ armed: false })
        });

        hideSuspiciousActivityModal();
        await getStatus();
        await getLiveFeed();
    } catch (error) {
        console.error('Error disarming system:', error);
        alert(error.message);
    }
}

async function resolveAlarm() {
    try {
        const intrusionId = currentStatus?.intrusion?.id || null;

        await fetchJson(`${API_BASE_URL}/resolve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intrusionId,
                note: 'Resolved by dashboard user',
                resolutionType: 'user_resolved'
            })
        });

        hideSuspiciousActivityModal();
        await getStatus();
        await getLiveFeed();
    } catch (error) {
        console.error('Error resolving alarm:', error);
        alert(error.message);
    }
}

async function confirmSuspiciousActivityAsUser() {
    if (suspiciousActionInProgress) return;

    suspiciousActionInProgress = true;
    const note = qs('suspiciousUserNote')?.value?.trim() || 'User confirmed activity was expected';

    try {
        await fetchJson(`${API_BASE_URL}/resolve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intrusionId: activePromptIntrusionId,
                note,
                resolutionType: 'user_confirmed'
            })
        });

        hideSuspiciousActivityModal();
        await getStatus();
        await getLiveFeed();
    } catch (error) {
        console.error('Error confirming suspicious activity:', error);
        alert(error.message);
    } finally {
        suspiciousActionInProgress = false;
    }
}

async function triggerAlarmFromModal() {
    if (suspiciousActionInProgress) return;

    suspiciousActionInProgress = true;
    const note = qs('suspiciousUserNote')?.value?.trim() || 'User requested alarm trigger';

    try {
        await fetchJson(`${API_BASE_URL}/trigger-alarm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intrusionId: activePromptIntrusionId,
                note,
                triggerSource: 'dashboard_user_confirmation'
            })
        });

        hideSuspiciousActivityModal();
        await getStatus();
        await getLiveFeed();
    } catch (error) {
        console.error('Error triggering alarm:', error);
        alert(error.message);
    } finally {
        suspiciousActionInProgress = false;
    }
}

function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-circle');

    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetView = button.getAttribute('data-view');

            document.querySelectorAll('.nav-circle').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            ['intrusionView', 'metricsView', 'historyView', 'settingsView'].forEach(viewId => {
                const view = qs(viewId);
                if (!view) return;

                if (viewId === targetView) {
                    view.classList.remove('d-none');
                } else {
                    view.classList.add('d-none');
                }
            });

            if (targetView === 'historyView') {
                renderHistoryList();
            }
        });
    });
}

function initEventHandlers() {
    qs('armStatusBtn').addEventListener('click', async () => {
        if (isArmed) {
            await disarmSystem();
        } else {
            await armSystem();
        }
    });

    qs('cancelAlarmBtn').addEventListener('click', async () => {
        await resolveAlarm();
    });

    qs('confirmUserResponsibleBtn').addEventListener('click', async () => {
        await confirmSuspiciousActivityAsUser();
    });

    qs('triggerAlarmBtn').addEventListener('click', async () => {
        await triggerAlarmFromModal();
    });

    qs('saveSettingsBtn').addEventListener('click', async () => {
        await saveSettings();
    });

    initMetricsViewToggle();

    window.addEventListener('resize', () => {
        drawAllMetricCharts();
    });
}

async function initialLoad() {
    await Promise.all([
        getStatus(),
        getLiveFeed(),
        getSettings()
    ]);
}

function setMetricsViewMode(mode) {
    metricsViewMode = mode;

    const currentBtn = qs('metricsCurrentToggle');
    const trendBtn = qs('metricsTrendToggle');
    const currentView = qs('metricsCurrentView');
    const trendView = qs('metricsTrendView');

    const isCurrent = mode === 'current';

    currentBtn.classList.toggle('btn-primary', isCurrent);
    currentBtn.classList.toggle('btn-outline-light', !isCurrent);
    currentBtn.classList.toggle('active', isCurrent);

    trendBtn.classList.toggle('btn-primary', !isCurrent);
    trendBtn.classList.toggle('btn-outline-light', isCurrent);
    trendBtn.classList.toggle('active', !isCurrent);

    currentView.classList.toggle('d-none', !isCurrent);
    trendView.classList.toggle('d-none', isCurrent);

    drawAllMetricCharts();
}

function initMetricsViewToggle() {
    qs('metricsCurrentToggle')?.addEventListener('click', () => {
        setMetricsViewMode('current');
    });

    qs('metricsTrendToggle')?.addEventListener('click', () => {
        setMetricsViewMode('trend');
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    initEventHandlers();
    await initialLoad();

    setInterval(async () => {
        await getStatus();
        await getLiveFeed();
    }, 4000);
});