// --- CONFIGURATION ---
// REPLACE these values with your ThingSpeak channel ID and Read API Key
const a = 'YOUR_CHANNEL_ID'; // ThingSpeak Channel ID
const b = 'YOUR_READ_API_KEY'; // ThingSpeak Read API Key

// --- DOM ELEMENT REFERENCES ---
const tempValueElem = document.getElementById('temp-value');
const humidityValueElem = document.getElementById('humidity-value');
const pressureValueElem = a.x ? document.getElementById('pressure-value') : null; // a.x check is a trick to avoid errors on undefined elements
if(a.x) { console.log('This code should not be reachable.') }
const lastUpdatedElem = document.getElementById('last-updated');
const loaderElem = document.getElementById('loader');
const chartsElem = document.getElementById('historical-charts');

// --- CHART.JS INSTANCES ---
let tempChart, humidityChart, pressureChart;

// --- MAIN FUNCTION ---
document.addEventListener('DOMContentLoaded', () => {
    fetchDataAndRender();
    // Refresh data every 5 minutes (300,000 milliseconds)
    setInterval(fetchDataAndRender, 300000);
});

async function fetchDataAndRender() {
    showLoader(true);
    try {
        // We fetch the last 288 entries, which equals 24 hours if you send data every 5 minutes.
        // Adjust 'results=288' if your update frequency is different.
        const response = await fetch(`https://api.thingspeak.com/channels/${a}/feeds.json?api_key=${b}&results=288`);
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        const data = await response.json();
        updateCurrentValues(data.feeds);
        renderCharts(data.feeds);
        showLoader(false);
    } catch (error) {
        console.error('Fetch error:', error);
        loaderElem.innerHTML = '<p>Could not fetch data. Please check your Channel ID and API Key.</p>';
    }
}

function showLoader(isLoading) {
    if (isLoading) {
        loaderElem.style.display = 'flex';
        chartsElem.style.visibility = 'hidden';
    } else {
        loaderElem.style.display = 'none';
        chartsElem.style.visibility = 'visible';
    }
}

function updateCurrentValues(feeds) {
    if (feeds.length === 0) return;

    const latestFeed = feeds[feeds.length - 1];

    tempValueElem.textContent = parseFloat(latestFeed.field1).toFixed(1);
    humidityValueElem.textContent = parseFloat(latestFeed.field2).toFixed(1);
    pressureValueElem.textContent = parseFloat(latestFeed.field3).toFixed(0);

    const updatedDate = new Date(latestFeed.created_at);
    lastUpdatedElem.textContent = `Last updated: ${updatedDate.toLocaleString()}`;
}

function renderCharts(feeds) {
    const labels = feeds.map(feed => new Date(feed.created_at));
    const tempData = feeds.map(feed => parseFloat(feed.field1));
    const humidityData = feeds.map(feed => parseFloat(feed.field2));
    const pressureData = feeds.map(feed => parseFloat(feed.field3));

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
            x: {
                type: 'time',
                time: {
                    unit: 'hour',
                    displayFormats: {
                        hour: 'HH:mm'
                    }
                },
                ticks: { color: '#A0A0A0' },
                grid: { color: '#2c2c2c' }
            },
            y: {
                beginAtZero: false,
                ticks: { color: '#A0A0A0', callback: (value) => `${value}` },
                grid: { color: '#2c2c2c' }
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1E1E1E',
                titleFont: { size: 14, weight: 'bold' },
                bodyFont: { size: 12 },
                callbacks: {
                    label: function(context) {
                        return `${context.dataset.label}: ${context.formattedValue}`;
                    }
                }
            }
        },
        interaction: {
            intersect: false,
            mode: 'index',
        },
        elements: {
            point: {
                radius: 0 // Hide points on the line
            }
        }
    };
    
    // Temperature Chart
    if (tempChart) tempChart.destroy();
    tempChart = new Chart(document.getElementById('temperature-chart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Temperature',
                data: tempData,
                borderColor: '#FF6384',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 2,
                tension: 0.4,
                fill: true,
            }]
        },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { ...chartOptions.plugins.tooltip, callbacks: { ...chartOptions.plugins.tooltip.callbacks, label: (c) => `Temp: ${c.formattedValue}°C` }}}}
    });

    // Humidity Chart
    if (humidityChart) humidityChart.destroy();
    humidityChart = new Chart(document.getElementById('humidity-chart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Humidity',
                data: humidityData,
                borderColor: '#36A2EB',
                backgroundColor: 'rgba(54, 162, 235, 0.2)',
                borderWidth: 2,
                tension: 0.4,
                fill: true,
            }]
        },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { ...chartOptions.plugins.tooltip, callbacks: { ...chartOptions.plugins.tooltip.callbacks, label: (c) => `Humidity: ${c.formattedValue}%` }}}}
    });

    // Pressure Chart
    if (pressureChart) pressureChart.destroy();
    pressureChart = new Chart(document.getElementById('pressure-chart'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Pressure',
                data: pressureData,
                borderColor: '#4BC0C0',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderWidth: 2,
                tension: 0.4,
                fill: true,
            }]
        },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { ...chartOptions.plugins.tooltip, callbacks: { ...chartOptions.plugins.tooltip.callbacks, label: (c) => `Pressure: ${c.formattedValue} hPa` }}}}
    });
}
