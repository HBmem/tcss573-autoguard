google.charts.load('current', { packages: ['gauge', 'corechart'] });
google.charts.setOnLoadCallback(initializeDashboard);

function initializeDashboard() {
  setupNavigation();
  drawCharts();
  window.addEventListener('resize', drawCharts);
}

function setupNavigation() {
  const buttons = document.querySelectorAll('.nav-circle');
  const views = {
    camera: document.getElementById('cameraView'),
    metrics: document.getElementById('metricsView'),
    history: document.getElementById('historyView'),
    settings: document.getElementById('settingsView')
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      buttons.forEach((btn) => btn.classList.remove('active'));
      Object.values(views).forEach((view) => view.classList.remove('active-view'));

      button.classList.add('active');
      views[button.dataset.view].classList.add('active-view');

      if (button.dataset.view === 'metrics') {
        drawCharts();
      }
    });
  });
}

function drawCharts() {
  drawGauge('tempGauge', 24.5, 0, 40);
  drawGauge('humidityGauge', 22, 0, 25);
  drawLineChart('tempLineChart', 'Temperature', [
    ['1:00', 18],
    ['1:10', 26],
    ['1:20', 23],
    ['1:30', 35],
    ['1:40', 36]
  ], 0, 40);
  drawLineChart('humidityLineChart', 'Humidity', [
    ['1:00', 20],
    ['1:10', 20.2],
    ['1:20', 21],
    ['1:30', 21],
    ['1:40', 22]
  ], 0, 25);
}

function drawGauge(elementId, value, min, max) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const data = google.visualization.arrayToDataTable([
    ['Label', 'Value'],
    ['', value]
  ]);

  const options = {
    width: 210,
    height: 120,
    min,
    max,
    redFrom: max * 0.8,
    redTo: max,
    yellowFrom: max * 0.55,
    yellowTo: max * 0.8,
    greenFrom: min,
    greenTo: max * 0.55,
    minorTicks: 0,
    majorTicks: ['', '', '', '', ''],
    animation: {
      duration: 500,
      easing: 'out'
    }
  };

  const chart = new google.visualization.Gauge(element);
  chart.draw(data, options);
}

function drawLineChart(elementId, seriesLabel, points, minValue, maxValue) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Time');
  data.addColumn('number', seriesLabel);
  data.addRows(points);

  const options = {
    backgroundColor: 'transparent',
    legend: { position: 'none' },
    chartArea: {
      left: 58,
      top: 28,
      width: '76%',
      height: '70%'
    },
    hAxis: {
      title: 'Time',
      textStyle: { color: '#222', fontSize: 12 },
      titleTextStyle: { color: '#222', italic: false }
    },
    vAxis: {
      title: seriesLabel,
      minValue,
      maxValue,
      gridlines: { color: '#c4c4c4' },
      textStyle: { color: '#222', fontSize: 12 },
      titleTextStyle: { color: '#222', italic: false }
    },
    lineWidth: 3,
    pointSize: 5,
    colors: ['#1f4db8'],
    curveType: 'none'
  };

  const chart = new google.visualization.LineChart(element);
  chart.draw(data, options);
}

const lockVehicleBtn = document.getElementById('lockVehicleBtn');
if (lockVehicleBtn) {
  lockVehicleBtn.addEventListener('click', () => {
    lockVehicleBtn.textContent = lockVehicleBtn.textContent === 'Lock Vehicle' ? 'Vehicle Locked' : 'Lock Vehicle';
  });
}
