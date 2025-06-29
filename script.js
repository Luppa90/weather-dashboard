// --- CONFIGURATION ---
// REPLACE these values with your ThingSpeak channel ID and Read API Key
const CHANNEL_ID = '3000045'; 
const READ_API_KEY = '0Z0Q3YOZYC8U5CA6';

// --- DOM ELEMENT REFERENCES ---
const tempValueElem = document.getElementById('temp-value');
const humidityValueElem = document.getElementById('humidity-value');
const pressureValueElem = document.getElementById('pressure-value');
const lastUpdatedElem = document.getElementById('last-updated');
const loaderElem = document.getElementById('loader');
const chartsElem = document.getElementById('historical-charts');

// --- CHART.JS INSTANCES ---
let tempChart, humidityChart, pressureChart;

// --- MAIN FUNCTION ---
document.addEventListener('DOMContentLoaded', () => {
    fetchDataAndRender();
    // Refresh data every 1 minute (60,000 milliseconds) for a "live" feel
    setInterval(fetchDataAndRender, 60000);
});

async function fetchDataAndRender() {
    showLoader(true, "Fetching latest data...");
    try {
        // We fetch the last 360 entries. With updates every 20 seconds, this equals the last 2 hours of data.
        const response = await fetch(`https://api.thingspeak.com/channels/${CHANNEL_ID}/feeds.json?api_key=${READ_API_KEY}&results=360`);
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        const data = await response.json();

        if (!data || !data.feeds || data.feeds.length === 0) {
            showLoader(true, "No data received from ThingSpeak yet. Waiting for the first update...");
            return;
        }

        updateCurrentValues(data.feeds);
        renderCharts(data.feeds);
        showLoader(false);

    } catch (error) {
        console.error('An error occurred:', error);
        showLoader(true, 'Could not fetch or render data. Please check browser console for errors.');
    }
}

function showLoader(isLoading, message = "Fetching latest data...") {
    if (isLoading) {
        loaderElem.style.display = 'flex';
        loaderElem.querySelector('p').textContent = message;
        chartsElem.style.visibility = 'hidden';
    } else {
        loaderElem.style.display = 'none';
        chartsElem.style.visibility = 'visible';
    }
}

function updateCurrentValues(feeds) {
    const latestFeed = feeds[feeds.length - 1];
    tempValueElem.textContent = latestFeed.field1 ? parseFloat(latestFeed.field1).toFixed(1) : 'N/A';
    humidityValueElem.textContent = latestFeed.field2 ? parseFloat(latestFeed.field2).toFixed(1) : 'N/A';
    pressureValueElem.textContent = latestFeed.field3 ? parseFloat(latestFeed.field3).toFixed(0) : 'N/A';
    const updatedDate = new Date(latestFeed.created_at);
    lastUpdatedElem.textContent = `Last updated: ${updatedDate.toLocaleString()}`;
}

function renderCharts(feeds) {
    const cleanFeeds = feeds.filter(feed => feed.created_at);
    const labels = cleanFeeds.map(feed => new Date(feed.created_at));
    const tempData = cleanFeeds.map(feed => parseFloat(feed.field1));
    const humidityData = cleanFeeds.map(feed => parseFloat(feed.field2));
    const pressureData = cleanFeeds.map(feed => parseFloat(feed.field3));
    
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: true,
        scales: {
            x: {
                type: 'time',
                time: { unit: 'minute', displayFormats: { minute: 'HH:mm' }}, // Adjust time unit for clarity
                ticks: { color: '#A0A0A0', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, // Improve label display
                grid: { color: '#2c2c2c' }
            },
            y: {
                beginAtZero: false,
                ticks: { color: '#A0A0A0' },
                grid: { color: '#2c2c2c' }
            }
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1E1E1E',
                titleFont: { size: 14, weight: 'bold' },
                bodyFont: { size: 12 },
                intersect: false,
                mode: 'index',
            }
        },
        elements: {
            point: { radius: 0, hitRadius: 10, hoverRadius: 5 }, 
            line: { tension: 0.4 }
        }
    };
    
    const getDataset = (label, data, color) => ({
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: `${color}33`,
        borderWidth: 2,
        fill: true,
    });

    if (tempChart) tempChart.destroy();
    tempChart = new Chart(document.getElementById('temperature-chart'), {
        type: 'line',
        data: { labels: labels, datasets: [getDataset('Temperature', tempData, '#FF6384')] },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Temp: ${c.formattedValue}°C` }}}}
    });

    if (humidityChart) humidityChart.destroy();
    humidityChart = new Chart(document.getElementById('humidity-chart'), {
        type: 'line',
        data: { labels: labels, datasets: [getDataset('Humidity', humidityData, '#36A2EB')] },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Humidity: ${c.formattedValue}%` }}}}
    });

    if (pressureChart) pressureChart.destroy();
    pressureChart = new Chart(document.getElementById('pressure-chart'), {
        type: 'line',
        data: { labels: labels, datasets: [getDataset('Pressure', pressureData, '#4BC0C0')] },
        options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Pressure: ${c.formattedValue} hPa` }}}}
    });
}
