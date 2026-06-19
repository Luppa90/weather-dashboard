# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a simple weather dashboard application that displays real-time weather data from a ThingSpeak IoT channel. It's a static HTML/CSS/JavaScript web application with no build process or dependencies.

## Development Commands

This is a static web application with no build tools, package managers, or testing frameworks. To run:
- Open `index.html` directly in a web browser, or
- Serve the files using any static web server (e.g., `python -m http.server` or `npx serve`)

## Architecture

### Core Files
- `index.html` - Main HTML structure with weather cards and chart containers
- `script.js` - JavaScript logic for ThingSpeak API integration and Chart.js rendering
- `style.css` - Dark theme styling with CSS Grid/Flexbox responsive layout

### Data Flow
1. Every 60 seconds the app makes three ThingSpeak requests (in parallel):
   - `results=360` — recent ~3h window (sampling is every 30s) for the current-condition cards and the temperature/humidity trend charts
   - `days=N&average=M` — server-side-averaged pressure series for the selected range (24h/3d/7d), so longer ranges stay smooth instead of showing 30-second noise
   - `days=2&average=15` — 2-day series used to compute the 3h / 24h pressure tendency and migraine-risk indicator
2. Latest values update the current condition cards (temperature, humidity, pressure)
3. Pressure chart overlays user-logged migraine events as vertical markers (chartjs-plugin-annotation)
4. Error handling displays loader messages for network issues or missing data

### Key Components
- **ThingSpeak Integration**: Configured for Channel ID `3000045` with Read API Key; uses the `days`/`average` params for downsampled history
- **Chart.js Visualization**: Temperature, humidity, and pressure time-series charts with dark theme styling; pressure chart uses the annotation plugin for migraine markers
- **Migraine Tracking**: Migraine events stored in `localStorage` (`migraineEvents`), rendered as chart markers and as a removable chip list, to help correlate symptoms with barometric pressure
- **Pressure Tendency / Risk**: 3h and 24h pressure change with a Low/Moderate/Elevated risk badge (thresholds in the `RISK` object in `script.js`)
- **Responsive Design**: Mobile-first CSS Grid layout adapting to tablet/desktop screens
- **Real-time Updates**: Auto-refresh mechanism with loading states

### Configuration
- ThingSpeak credentials are hardcoded near the top of `script.js` (read key; inherently public in a static client app)
- Chart styling uses CSS custom properties defined in `:root`
- Data mapping: field1=temperature, field2=humidity, field3=pressure, field4=altitude (altitude is collected but unused)
- Pressure chart ranges and averaging live in the `RANGES` object; migraine-risk thresholds in the `RISK` object