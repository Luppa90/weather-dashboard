// --- CONFIGURATION ---
// REPLACE these values with your ThingSpeak channel ID and Read API Key
const CHANNEL_ID = '3000045'; 
const READ_API_KEY = '0Z0Q3YOZYC8U5CA6';

// --- DOM ELEMENT REFERENCES ---
// We will access these inside the DOMContentLoaded event to ensure the page is loaded.
let tempValueElem, humidityValueElem, pressureValueElem, lastUpdatedElem, loaderElem, chartsElem;
let pressureStatusElem, pressureStatusMessageElem, pressureIconElem;
let tempChart, humidityChart, pressureChart;

// --- PRESSURE MONITORING ---
const SIGNIFICANT_PRESSURE_CHANGE = 4; // hPa change that signals potential weather change

// --- MAIN FUNCTION ---
document.addEventListener('DOMContentLoaded', () => {
    tempValueElem = document.getElementById('temp-value');
    humidityValueElem = document.getElementById('humidity-value');
    pressureValueElem = document.getElementById('pressure-value');
    lastUpdatedElem = document.getElementById('last-updated');
    loaderElem = document.getElementById('loader');
    chartsElem = document.getElementById('historical-charts');
    pressureStatusElem = document.getElementById('pressure-status');
    pressureStatusMessageElem = document.getElementById('pressure-status-message');
    pressureIconElem = document.getElementById('pressure-icon');

    // Initial fetch
    fetchDataAndRender();
    // Refresh data every 1 minute (60,000 milliseconds) for a "live" feel
    setInterval(fetchDataAndRender, 60000);
});

async function fetchDataAndRender() {
    // Only show loader on initial load (when charts don't exist yet)
    const isInitialLoad = !tempChart && !humidityChart && !pressureChart;
    if (isInitialLoad) {
        showLoader(true, "Fetching latest data...");
    }
    
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
        updatePressureStatus(data.feeds);
        
        // Add subtle visual feedback for background updates
        if (!isInitialLoad && lastUpdatedElem) {
            lastUpdatedElem.style.opacity = '0.5';
            setTimeout(() => {
                if (lastUpdatedElem) lastUpdatedElem.style.opacity = '1';
            }, 300);
        }
        
        // Only hide loader if we showed it (on initial load)
        if (isInitialLoad) {
            showLoader(false);
        }

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
    // Show charts when loading is complete
    if (chartsElem && !isLoading) {
        chartsElem.style.visibility = 'visible';
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
        const now = new Date();
        const diffMs = now - updatedDate;
        const diffSeconds = Math.floor(diffMs / 1000);
        const diffMinutes = Math.floor(diffSeconds / 60);
        
        let relativeTime;
        if (diffMinutes < 1) {
            relativeTime = `${diffSeconds} seconds ago`;
        } else {
            relativeTime = `${diffMinutes} minutes ago`;
        }
        
        lastUpdatedElem.textContent = `Last updated: ${updatedDate.toLocaleString()} (${relativeTime})`;
    }
}

function renderCharts(feeds) {
    const cleanFeeds = feeds.filter(feed => feed.created_at);
    
    // Find the largest gap and filter out old data if gap > 4 hours
    const MAJOR_GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
    const GAP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    
    let filteredFeeds = cleanFeeds;
    let largestGapIndex = -1;
    let largestGapSize = 0;
    
    // Find the largest gap
    for (let i = 0; i < cleanFeeds.length - 1; i++) {
        const currentTime = new Date(cleanFeeds[i].created_at);
        const nextTime = new Date(cleanFeeds[i + 1].created_at);
        const timeDiff = nextTime - currentTime;
        
        if (timeDiff > largestGapSize) {
            largestGapSize = timeDiff;
            largestGapIndex = i;
        }
    }
    
    // If largest gap is > 4 hours, only use data after the gap
    if (largestGapSize > MAJOR_GAP_THRESHOLD_MS) {
        filteredFeeds = cleanFeeds.slice(largestGapIndex + 1);
    }
    
    // Process remaining data to handle smaller gaps - insert null values for gaps > 10 minutes
    const processedData = [];
    
    for (let i = 0; i < filteredFeeds.length; i++) {
        const currentFeed = filteredFeeds[i];
        processedData.push(currentFeed);
        
        // Check if there's a gap to the next data point
        if (i < filteredFeeds.length - 1) {
            const nextFeed = filteredFeeds[i + 1];
            const currentTime = new Date(currentFeed.created_at);
            const nextTime = new Date(nextFeed.created_at);
            const timeDiff = nextTime - currentTime;
            
            // If gap is larger than threshold but smaller than major gap, insert a null data point
            if (timeDiff > GAP_THRESHOLD_MS) {
                processedData.push({
                    created_at: new Date(currentTime.getTime() + 60000).toISOString(), // 1 minute after last point
                    field1: null,
                    field2: null,
                    field3: null
                });
            }
        }
    }
    
    const labels = processedData.map(feed => new Date(feed.created_at));
    const tempData = processedData.map(feed => feed.field1 ? parseFloat(feed.field1) : null);
    const humidityData = processedData.map(feed => feed.field2 ? parseFloat(feed.field2) : null);
    const pressureData = processedData.map(feed => feed.field3 ? parseFloat(feed.field3) : null);
    
    const getChartOptions = (yAxisConfig) => ({
        responsive: true,
        maintainAspectRatio: true,
        scales: {
            x: { type: 'time', time: { unit: 'minute', displayFormats: { minute: 'HH:mm' }}, ticks: { color: '#A0A0A0', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: '#2c2c2c' }},
            y: { ...yAxisConfig, ticks: { color: '#A0A0A0' }, grid: { color: '#2c2c2c' }}
        },
        plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: '#1E1E1E', titleFont: { size: 14, weight: 'bold' }, bodyFont: { size: 12 }, intersect: false, mode: 'index' }
        },
        elements: { point: { radius: 0, hitRadius: 10, hoverRadius: 5 }, line: { tension: 0.4 }}
    });
    
    const getDataset = (label, data, color) => ({
        label: label, data: data, borderColor: color, backgroundColor: `${color}33`, borderWidth: 2, fill: true, spanGaps: false
    });

    const tempCanvas = document.getElementById('temperature-chart');
    if (tempCanvas) {
        const minTemp = Math.min(...tempData.filter(t => t !== null && !isNaN(t)));
        const maxTemp = Math.max(...tempData.filter(t => t !== null && !isNaN(t)));
        const tempRange = maxTemp - minTemp;
        const tempPadding = Math.max(2, tempRange * 0.2); // At least 2°C padding, or 20% of range
        const tempYAxis = { 
            min: Math.floor(minTemp - tempPadding), 
            max: Math.ceil(maxTemp + tempPadding) 
        };
        
        if (tempChart) {
            // Update existing chart data smoothly
            tempChart.data.labels = labels;
            tempChart.data.datasets[0].data = tempData;
            tempChart.options.scales.y.min = tempYAxis.min;
            tempChart.options.scales.y.max = tempYAxis.max;
            tempChart.update('none'); // 'none' mode for instant update without animation
        } else {
            // Create chart for the first time
            tempChart = new Chart(tempCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Temperature', tempData, '#FF6384')] }, options: { ...getChartOptions(tempYAxis), plugins: { ...getChartOptions(tempYAxis).plugins, tooltip: { callbacks: { label: (c) => `Temp: ${c.formattedValue}°C` }}}} });
        }
    }

    const humidityCanvas = document.getElementById('humidity-chart');
    if (humidityCanvas) {
        const minHumidity = Math.min(...humidityData.filter(h => h !== null && !isNaN(h)));
        const maxHumidity = Math.max(...humidityData.filter(h => h !== null && !isNaN(h)));
        const humidityRange = maxHumidity - minHumidity;
        const humidityPadding = Math.max(5, humidityRange * 0.2); // At least 5% padding, or 20% of range
        const humidityYAxis = { 
            min: Math.max(0, Math.floor(minHumidity - humidityPadding)), 
            max: Math.min(100, Math.ceil(maxHumidity + humidityPadding)) 
        };
        
        if (humidityChart) {
            // Update existing chart data smoothly
            humidityChart.data.labels = labels;
            humidityChart.data.datasets[0].data = humidityData;
            humidityChart.options.scales.y.min = humidityYAxis.min;
            humidityChart.options.scales.y.max = humidityYAxis.max;
            humidityChart.update('none'); // 'none' mode for instant update without animation
        } else {
            // Create chart for the first time
            humidityChart = new Chart(humidityCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Humidity', humidityData, '#36A2EB')] }, options: { ...getChartOptions(humidityYAxis), plugins: { ...getChartOptions(humidityYAxis).plugins, tooltip: { callbacks: { label: (c) => `Humidity: ${c.formattedValue}%` }}}} });
        }
    }

    const pressureCanvas = document.getElementById('pressure-chart');
    if (pressureCanvas) {
        const minPressure = Math.min(...pressureData.filter(p => p !== null && !isNaN(p)));
        const maxPressure = Math.max(...pressureData.filter(p => p !== null && !isNaN(p)));
        const pressureRange = maxPressure - minPressure;
        const pressurePadding = Math.max(10, pressureRange * 0.2); // At least 10 hPa padding, or 20% of range
        const pressureYAxis = { 
            min: Math.floor(minPressure - pressurePadding), 
            max: Math.ceil(maxPressure + pressurePadding) 
        };
        
        if (pressureChart) {
            // Update existing chart data smoothly
            pressureChart.data.labels = labels;
            pressureChart.data.datasets[0].data = pressureData;
            pressureChart.options.scales.y.min = pressureYAxis.min;
            pressureChart.options.scales.y.max = pressureYAxis.max;
            pressureChart.update('none'); // 'none' mode for instant update without animation
        } else {
            // Create chart for the first time
            pressureChart = new Chart(pressureCanvas, { type: 'line', data: { labels: labels, datasets: [getDataset('Pressure', pressureData, '#4BC0C0')] }, options: { ...getChartOptions(pressureYAxis), plugins: { ...getChartOptions(pressureYAxis).plugins, tooltip: { callbacks: { label: (c) => `Pressure: ${c.formattedValue} hPa` }}}} });
        }
    }
}

function updatePressureStatus(feeds) {
    if (!feeds || feeds.length < 20) return; // Need sufficient data to analyze trends
    
    const pressureData = feeds
        .map(feed => parseFloat(feed.field3))
        .filter(pressure => !isNaN(pressure));
    
    if (pressureData.length < 20) return;
    
    // Compare recent readings (last 15) with older readings (first 15-30)
    const recentReadings = pressureData.slice(-15);
    const olderReadings = pressureData.slice(0, Math.min(30, pressureData.length - 15));
    
    const recentAvg = recentReadings.reduce((sum, p) => sum + p, 0) / recentReadings.length;
    const olderAvg = olderReadings.reduce((sum, p) => sum + p, 0) / olderReadings.length;
    const pressureChange = recentAvg - olderAvg;
    
    if (!pressureStatusElem || !pressureStatusMessageElem || !pressureIconElem) return;
    
    // Only show status when there's a significant change that could signal weather changes
    if (Math.abs(pressureChange) >= SIGNIFICANT_PRESSURE_CHANGE) {
        // Calculate time span for the comparison
        const timeSpanHours = Math.round((feeds.length * 2) / 60 * 10) / 10; // Assuming 2-minute intervals, rounded to 1 decimal
        
        let status, message, iconClass;
        
        if (pressureChange > 0) {
            status = 'rising';
            message = `Sharp pressure rise: +${pressureChange.toFixed(1)} hPa over ~${timeSpanHours}h - possible weather improvement`;
            iconClass = 'fas fa-arrow-up';
        } else {
            status = 'falling';
            message = `Sharp pressure drop: ${pressureChange.toFixed(1)} hPa over ~${timeSpanHours}h - possible weather deterioration`;
            iconClass = 'fas fa-arrow-down';
        }
        
        // Update the status display
        pressureStatusElem.className = `status-banner ${status}`;
        pressureStatusElem.style.display = 'block';
        pressureStatusMessageElem.textContent = message;
        pressureIconElem.className = iconClass;
    } else {
        // Hide the status when pressure changes are not significant
        pressureStatusElem.style.display = 'none';
    }
}
