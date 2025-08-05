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
1. Application fetches data from ThingSpeak API every 60 seconds
2. Latest values update the current condition cards (temperature, humidity, pressure)
3. Historical data (last 360 readings) renders three Chart.js line charts
4. Error handling displays loader messages for network issues or missing data

### Key Components
- **ThingSpeak Integration**: Configured for Channel ID `3000045` with Read API Key
- **Chart.js Visualization**: Three responsive time-series charts with dark theme styling
- **Responsive Design**: Mobile-first CSS Grid layout adapting to tablet/desktop screens
- **Real-time Updates**: Auto-refresh mechanism with loading states

### Configuration
- ThingSpeak credentials are hardcoded in `script.js:3-4`
- Chart styling uses CSS custom properties defined in `:root`
- Data mapping: field1=temperature, field2=humidity, field3=pressure