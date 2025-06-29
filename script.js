// --- CONFIGURATION ---
// REPLACE these values with your ThingSpeak channel ID and Read API Key
const CHANNEL_ID = '3000045'; 
const READ_API_KEY = '0Z0Q3YOZYC8U5CA6';

// --- DOM ELEMENT REFERENCES ---
// We will access these inside the DOMContentLoaded event to ensure the page is loaded.
let tempValueElem, humidityValueElem, pressureValueElem, lastUpdatedElem, loaderElem, chartsElem;
let tempChart, humidityChart, pressureChart;

// --- MAIN FUNCTION ---
document.addEventListener('DOMContentLoaded', () => {
    tempValueElem = document.getElementById('temp-value');
    humidityValueElem = document.getElementById('humidity-value');
    pressureValueElem = document.getElementById('pressure-value');
    lastUpdatedElem = document.getElementById('last-updated');
    loaderElem = document.getElementById('loader');
    chartsElem = document.getElementById('historical-charts');

    // Initial fetch
    fetchDataAndRender();
    // Refresh data every 1 minute (60,000 milliseconds) for a "live" feel
    setInterval(fetchDataAndRender, 60000);
});

async function fetchDataAndRender() {
    showLoader(true, "Fetching latest data...");
    try {
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
        console.error('An error occurred during fetch or render:', error);
        showLoader(true, `Error: ${error.message}. Please check console.`);
    }
}

function showLoader(isLoading, message = "Fetching latest data...") {
    if (loaderElem) {
        if (isLoading) {
            loaderElem.style.display = 'flex';
            const p = loaderElem.querySelector('p');
            if (p) p.textContent = message;
        } else {
            loaderElem.style.display = 'none';
        }
    }
    if (chartsElem) {
        chartsElem.style.visibility = isLoading ? 'hidden' : 'visible';
    }
}

function updateCurrentValues(feeds) {
    const latestFeed = feeds[feeds.length - 1];

    // **THE FIX: Check if each element exists before trying to update it.**
    // This makes the code resilient. If you decide to remove a card from the HTML, the script won't crash.
    if (tempValueElem) {
        tempValueElem.textContent = latestFeed.field1 ? parseFloat(latestFeed.field1).toFixed(1) : 'N/A';
    }
    if (humidityValueElem) {
        humidityValueElem.textContent = latestFeed.field2 ? parseFloat(latestFeed.field2).toFixed(1) : 'N/A';
    }
    if (pressureValueElem) {
        pressureValueElem.textContent = latestFeed.field3 ? parseFloat(latestFeed.field3).toFixed(0) : 'N/A';
    }
    if (lastUpdatedElem) {
        const updatedDate = new Date(latestFeed.created_at);
        lastUpdatedElem.textContent = `Last updated: ${updatedDate.toLocaleString()}`;
    }
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
            x: { type: 'time', time: { unit: 'minute', displayFormats: { minute: 'HH:mm' }}, ticks: { color: '#A0A0A0', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: '#2c2c2c' }},
            y: { beginAtZero: false, ticks: { color: '#A0A0A0' }, grid: { color: '#2c2c2c' }}
        },
        plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: '#1E1E1E', titleFont: { size: 14, weight: 'bold' }, bodyFont: { size: 12 }, intersect: false, mode: 'index' }
        },
        elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 5 }, line: { tension: 0.4 }}
    };
    
    const getDataset = (label, data, color) => ({
        label: label, data: data, borderColor: color, backgroundColor: `${color}33`, borderWidth: 2, fill: true
    });

    const tempCanvas = document.getElementById('temperature-chart');
    if (tempCanvas) {
        if (tempChart) tempChart.destroy();
        tempChart = new Chart(tempCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Temperature', tempData, '#FF6384')] }, options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Temp: ${c.formattedValue}°C` }}}} });
    }

    const humidityCanvas = document.getElementById('humidity-chart');
    if (humidityCanvas) {
        if (humidityChart) humidityChart.destroy();
        humidityChart = new Chart(humidityCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Humidity', humidityData, '#36A2EB')] }, options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Humidity: ${c.formattedValue}%` }}}} });
    }

    const pressureCanvas = document.getElementById('pressure-chart');
    if (pressureCanvas) {
        if (pressureChart) pressureChart.destroy();
        pressureChart = new Chart(pressureCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Pressure', pressureData, '#4BC0C0')] }, options: { ...chartOptions, plugins: { ...chartOptions.plugins, tooltip: { callbacks: { label: (c) => `Pressure: ${c.formattedValue} hPa` }}}} });
    }
}
