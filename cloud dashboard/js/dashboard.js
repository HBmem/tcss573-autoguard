// const API_BASE_URL = 'https://10.0.0.203:1880/api';
const API_BASE_URL = 'https://10.0.0.91:1880/api';
// const API_BASE_URL = 'https://10.18.50.103:1880/api';

// Cloud endpoints
const S3_BUCKET = "tcss573-autoguard";
const S3_REGION = "us-east-2";
const S3_BASE_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
const CLOUD_API_URL = "https://vcj8c8rwpl.execute-api.us-east-1.amazonaws.com";

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

const chartHistory = {
    climate: [],
    security: []
};

google.charts.load('current', { packages: ['corechart'] });
google.charts.setOnLoadCallback(() => {
    drawClimateChart();
    drawSecurityChart();
});

function qs(id) {
    return document.getElementById(id);
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

// Cache URLs so we don't re-fetch for every render
const mediaUrlCache = {};

async function buildMediaUrl(intrusionId, type) {
    if (!intrusionId) return '';

    const cacheKey = `${intrusionId}_${type}`;
    if (mediaUrlCache[cacheKey]) return mediaUrlCache[cacheKey];

    try {
        const data = await fetchJson(
            `${CLOUD_API_URL}/media?intrusionId=${intrusionId}&type=${type}`
        );
        if (data.ok && data.url) {
            mediaUrlCache[cacheKey] = data.url;
            return data.url;
        }
    } catch (e) {
        console.error(`Failed to get pre-signed URL for ${intrusionId}:`, e);
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

// Remove pushMetricHistory calls from getStatus()
// Add this new function
async function fetchClimateHistory() {
    try {
        const data = await fetchJson(`${CLOUD_API_URL}/climate-history`);
        const rows = data.rows || [];

        // Check what fields actually come back
        console.log("Climate row sample:", rows[0]);

        chartHistory.climate = rows
            .reverse()
            .map(r => [
                new Date(r._time || r.time),           // handle both
                Number(r.temperatureC ?? r.temperature ?? null),
                Number(r.humidity ?? null)
            ])
            .filter(r => !isNaN(r[0].getTime()) && !isNaN(r[1]) && !isNaN(r[2]));  // remove invalid rows

        drawClimateChart();
    } catch (error) {
        console.error('Error fetching climate history:', error);
    }
}

function updateMetricCards(status) {
    const last = status?.last || {};

    qs('metricTemperature').textContent = last.temperatureC ?? '--';
    qs('metricHumidity').textContent = last.humidity ?? '--';
    qs('metricDistance').textContent = last.distanceCm ?? '--';
    qs('metricAccel').textContent = last.accelMag ?? '--';
}

function drawClimateChart() {
    const container = qs('climateChart');
    if (!container || !google.visualization) return;

    const data = new google.visualization.DataTable();
    data.addColumn('datetime', 'Time');
    data.addColumn('number', 'Temperature (°C)');
    data.addColumn('number', 'Humidity (%)');

    if (chartHistory.climate.length) {
        data.addRows(chartHistory.climate);
    }

    const chart = new google.visualization.LineChart(container);
    chart.draw(data, {
        backgroundColor: '#111827',
        chartArea: { left: 50, right: 20, top: 20, bottom: 50 },
        legend: { textStyle: { color: '#e2e8f0' } },
        hAxis: { textStyle: { color: '#94a3b8' }, gridlines: { color: '#1f2937' } },
        vAxis: { textStyle: { color: '#94a3b8' }, gridlines: { color: '#1f2937' } }
    });
}

function drawSecurityChart() {
    const container = qs('securityChart');
    if (!container || !google.visualization) return;

    const data = new google.visualization.DataTable();
    data.addColumn('datetime', 'Time');
    data.addColumn('number', 'Distance (cm)');
    data.addColumn('number', 'Vibration');
    data.addColumn('number', 'Acceleration');

    if (chartHistory.security.length) {
        data.addRows(chartHistory.security);
    }

    const chart = new google.visualization.LineChart(container);
    chart.draw(data, {
        backgroundColor: '#111827',
        chartArea: { left: 50, right: 20, top: 20, bottom: 50 },
        legend: { textStyle: { color: '#e2e8f0' } },
        hAxis: { textStyle: { color: '#94a3b8' }, gridlines: { color: '#1f2937' } },
        vAxis: { textStyle: { color: '#94a3b8' }, gridlines: { color: '#1f2937' } }
    });
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

async function renderSelectedIntrusion() {
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
    const imageUrl = group.intrusionId ? await buildMediaUrl(group.intrusionId, 'image') : '';
    const videoUrl = group.intrusionId ? await buildMediaUrl(group.intrusionId, 'video') : '';


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

    for (const event of group.events.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
            const block = document.createElement('div');
            block.className = 'event-block';

            const eventImageUrl = event.intrusionId ? await buildMediaUrl(event.intrusionId, 'image') : '';
            const eventVideoUrl = event.intrusionId ? await buildMediaUrl(event.intrusionId, 'video') : '';

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
        };
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

    const imageUrl = event.intrusionId ? buildMediaUrl(event.intrusionId, 'image') : '';
    const videoUrl = event.intrusionId ? buildMediaUrl(event.intrusionId, 'video') : '';


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
        updateMetricCards(data);
        pushMetricHistory(data);
        drawClimateChart();
        drawSecurityChart();
        handleSuspiciousActivityPrompt(data);
    } catch (error) {
        console.error('Error fetching status:', error);
        showToastMessage(error.message);
    }
}

async function getLiveFeed() {
    try {
        const data = await fetchJson(`${CLOUD_API_URL}/events`);
        const rows = data.rows || [];

        liveFeedEvents = rows.map(r => ({
            type: r.type || r._field || 'UNKNOWN',
            intrusionId: r.intrusionId || null,
            state: r.state || '--',
            reason: r.reason || '--',
            evidence: (() => {
                try { return JSON.parse(r.evidence || '[]'); }
                catch { return []; }
            })(),
            picturePath: r.picture_path || '',   // snake_case → camelCase
            videoPath: r.video_path || '',        // snake_case → camelCase
            note: r.note || '',
            ts: r._time ? new Date(r._time).getTime() : 0  // _time → ts
        }));

        // Populate security chart from the same rows
        chartHistory.security = rows
            .filter(r => r.distance_cm || r.vibration || r.accel_mag)
            .map(r => [
                new Date(r._time || r.time),
                Number(r.distance_cm ?? null),
                Number(r.vibration ?? null),
                Number(r.accel_mag ?? null)
            ])
            .filter(r => !isNaN(r[0].getTime()))
            .sort((a, b) => a[0] - b[0]);

        drawSecurityChart();

        const grouped = groupEventsByIntrusion(liveFeedEvents);
        if (grouped.length && !grouped.some(g =>
            (g.intrusionId || '__ungrouped__') === selectedIntrusionId)) {
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

    window.addEventListener('resize', () => {
        drawClimateChart();
        drawSecurityChart();
    });
}

async function initialLoad() {
    await Promise.all([
        getStatus(),
        getLiveFeed(),
        getSettings(),
        fetchClimateHistory(),
    ]);
}

document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();
    initEventHandlers();
    await initialLoad();

    setInterval(async () => {
        await getStatus();
        await getLiveFeed();
        await fetchClimateHistory();
    }, 8000);
});