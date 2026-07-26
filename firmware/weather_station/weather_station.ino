/* ESP32 weather station -> ThingSpeak channel 3000045
 *
 * BME280  (0x76) : temperature, humidity, pressure, altitude   -> field1..4
 * SCD41   (0x62) : CO2                                          -> field5
 *
 * The SCD41 does NOT replace the BME280. It measures CO2, temperature and
 * humidity but has no barometer, and barometric pressure is the measurement
 * the migraine tracking actually leans on. The two share the I2C bus.
 *
 * Libraries (Arduino IDE -> Tools -> Manage Libraries):
 *   Adafruit BME280 Library      (pulls in Adafruit Unified Sensor)
 *   Sensirion I2C SCD4x   >= 1.1.0
 *   Sensirion Core               (dependency of the above)
 *   ThingSpeak
 *
 * The CO2 sensor is optional at runtime: if it is not attached, the sketch
 * posts fields 1-4 as before and the dashboard keeps every CO2 panel hidden.
 *
 * Serial commands (115200 baud), one letter + Enter:
 *   i   print status (includes the BME280 cross-check)
 *   c   forced recalibration in fresh air  (see notes at performFrc)
 *   a   toggle automatic self-calibration
 *   x   rescan the I2C bus
 *   w   list the WiFi networks the radio can hear
 */

#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <SensirionI2cScd4x.h>
#include "ThingSpeak.h"
#include "time.h"

// The Sensirion driver expects NO_ERROR == 0; other headers define it too.
#ifdef NO_ERROR
#undef NO_ERROR
#endif
#define NO_ERROR 0

// --- User Configuration: WiFi ---
const char* ssid     = "Ooredoo-X16-FF352A";
const char* password = "0C485CEDUm!60";

// --- User Configuration: ThingSpeak ---
unsigned long myChannelNumber = 3000045;
const char* myWriteAPIKey     = "BO70JO7QUO5N8WMD";

// --- User Configuration: Sensors ---
#define SEALEVELPRESSURE_HPA (1013.25f)

/* Automatic self-calibration assumes the sensor sees outdoor air (~400 ppm)
 * for at least 4 uninterrupted hours once a week. A closed, air-conditioned
 * room does not satisfy that, and when the assumption fails ASC drags the
 * whole scale down — which would quietly understate exactly the elevated
 * readings this is here to measure. Left off, with a manual recalibration
 * instead (serial command 'c'). Turn it on if the room is aired regularly. */
const bool ENABLE_ASC = false;

// Outdoor CO2 baseline used by the forced recalibration.
const uint16_t FRC_TARGET_PPM = 425;

// --- Time Synchronization ---
const char* ntpServer          = "pool.ntp.org";
const long  gmtOffset_sec      = 3600;
const int   daylightOffset_sec = 0;

// --- Globals ---
Adafruit_BME280 bme;
SensirionI2cScd4x scd4x;
WiFiClient client;

bool bmeFound  = false;
bool scdFound  = false;

// Latest CO2 reading plus when it arrived, so a stale one is never posted as
// though it were current.
float    lastCo2Ppm  = NAN;
uint32_t lastCo2AtMs = 0;
const unsigned long co2MaxAgeMs = 3UL * 60UL * 1000UL;

// The main loop spins freely between posts, so the data-ready check is rate
// limited — otherwise it would issue thousands of I2C transactions a second.
unsigned long lastCo2PollMs = 0;
const unsigned long co2PollIntervalMs = 2000UL;

// ASC state is read once at boot: the query is an idle-mode-only command and
// cannot be issued while a measurement is running.
bool ascActive = false;

/* The SCD41 reports temperature and humidity too, but they are NOT used as
 * data — see the note above readMeasurement's caller. They are kept only as a
 * health cross-check against the BME280. */
float lastScdTempC = NAN;
float lastScdRh    = NAN;

// --- Timing ---
const unsigned long updateIntervalMs = 30000UL;
unsigned long lastUpdateMs = 0;

// --- Robustness / Recovery ---
int consecutiveFailCount = 0;                 // reset by the Wi-Fi stack reset
const int maxFailsBeforeWiFiReset = 6;

/* The station went quiet for two days once. Two things made that possible:
 * the reboot counter below used to share the counter that the Wi-Fi reset
 * cleared, so it could never be reached, and a hung socket had no real
 * timeout. Both are fixed; this is the last-resort backstop. */
unsigned long lastSuccessfulPostMs = 0;
const unsigned long rebootIfNoPostForMs = 30UL * 60UL * 1000UL;  // 30 minutes

volatile int lastDisconnectReason = 0;

// Forward declarations
void connectWiFi(bool verbose = true);
void ensureWiFi();
void printLocalTime();
void applyClientTimeout();
bool initScd4x();
void pollCo2();
void performFrc();
void toggleAsc();
void printStatus();
void handleSerial();
void scanI2C();
void scanWiFi();

static char scdErrMsg[64];

static void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[WiFi] STA connected to AP.");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[WiFi] Got IP: ");
      Serial.println(WiFi.localIP());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      lastDisconnectReason = info.wifi_sta_disconnected.reason;
      Serial.print("[WiFi] Disconnected. Reason code: ");
      Serial.println(lastDisconnectReason);
      break;
    default:
      break;
  }
}

void printLocalTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    Serial.println("Failed to obtain time");
    return;
  }
  char buf[64];
  strftime(buf, sizeof(buf), "%A, %B %d %Y %H:%M:%S", &timeinfo);
  Serial.print("Current time: ");
  Serial.println(buf);
}

/* WiFiClient::setTimeout means different things on different cores: on 2.x it
 * took SECONDS (so the old setTimeout(15000) asked for a four-hour socket
 * timeout), and on 3.x that override is gone entirely — setTimeout then falls
 * through to Stream::setTimeout, which only affects parsing helpers and not
 * the socket at all. setConnectionTimeout is the one that does what we want. */
void applyClientTimeout() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && (ESP_ARDUINO_VERSION_MAJOR >= 3)
  client.setConnectionTimeout(15000);   // milliseconds
#else
  client.setTimeout(15);                // seconds on core 2.x
#endif
}

// --------------------------------------------------------------------- SCD41
bool initScd4x() {
  scd4x.begin(Wire, SCD41_I2C_ADDR_62);
  delay(30);

  // The sensor may be mid-measurement after a warm reset; put it in a known
  // idle state before configuring anything.
  scd4x.wakeUp();
  scd4x.stopPeriodicMeasurement();
  delay(500);

  uint64_t serialNumber = 0;
  int16_t error = scd4x.getSerialNumber(serialNumber);
  if (error != NO_ERROR) {
    errorToString(error, scdErrMsg, sizeof scdErrMsg);
    Serial.print(" not detected ("); Serial.print(scdErrMsg); Serial.println(").");
    return false;
  }

  // Only write ASC to EEPROM when it actually differs — persistSettings has a
  // limited write endurance and this runs on every boot.
  uint16_t ascEnabled = 0;
  if (scd4x.getAutomaticSelfCalibrationEnabled(ascEnabled) == NO_ERROR) {
    uint16_t want = ENABLE_ASC ? 1 : 0;
    if (ascEnabled != want) {
      scd4x.setAutomaticSelfCalibrationEnabled(want);
      scd4x.persistSettings();
      Serial.printf(" ASC %s and saved.", want ? "enabled" : "disabled");
      ascEnabled = want;
    }
    ascActive = (ascEnabled != 0);
  }

  /* Low-power periodic mode updates every 30s, which matches the posting
   * interval and self-heats less than the 5s mode — self-heating matters here
   * because the sensor sits next to the BME280 we take temperature from. */
  error = scd4x.startLowPowerPeriodicMeasurement();
  if (error != NO_ERROR) {
    errorToString(error, scdErrMsg, sizeof scdErrMsg);
    Serial.print(" failed to start measurement ("); Serial.print(scdErrMsg); Serial.println(").");
    return false;
  }

  Serial.print(" found, serial 0x");
  Serial.print((uint32_t)(serialNumber >> 32), HEX);
  Serial.print((uint32_t)(serialNumber & 0xFFFFFFFF), HEX);
  Serial.println(". First reading in ~30s.");
  return true;
}

/* Called every loop. Reading only when the sensor says data is ready avoids
 * the NACK that a premature read would provoke. */
void pollCo2() {
  if (!scdFound) return;
  if (millis() - lastCo2PollMs < co2PollIntervalMs) return;
  lastCo2PollMs = millis();

  bool ready = false;
  if (scd4x.getDataReadyStatus(ready) != NO_ERROR || !ready) return;

  uint16_t co2 = 0;
  float scdTemp = 0.0f, scdRh = 0.0f;
  if (scd4x.readMeasurement(co2, scdTemp, scdRh) != NO_ERROR) return;

  // A zero reading means the sensor has not finished its first conversion.
  if (co2 == 0) return;

  lastCo2Ppm  = (float)co2;
  lastCo2AtMs = millis();

  /* Deliberately not posted, and deliberately not averaged with the BME280.
   * The SCD41 sits next to its own 205 mA heater, so its temperature error is
   * a systematic positive offset rather than random noise — averaging would
   * fold half of that bias permanently into the record instead of cancelling
   * it. Kept only so a large disagreement can flag a failing sensor. */
  lastScdTempC = scdTemp;
  lastScdRh    = scdRh;
}

/* Prints every responding I2C address. The fastest way to tell a wiring
 * mistake (nothing responds) from a sensor problem (it responds but misbehaves). */
void scanI2C() {
  Serial.println("Scanning I2C bus...");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() != 0) continue;
    Serial.printf("  found 0x%02X", addr);
    if (addr == 0x76 || addr == 0x77) Serial.print("   <- BME280");
    if (addr == 0x62) Serial.print("   <- SCD41");
    Serial.println();
    found++;
  }
  if (found == 0) {
    Serial.println("  nothing responded. Check SDA (GPIO21), SCL (GPIO22),");
    Serial.println("  power and a shared ground between every board.");
  }
}

/* Forced recalibration. Put the sensor in genuinely fresh air first — outdoors
 * or at a wide-open window, and stay well away from it, since breathing near
 * it will bias the reference. The sensor must run for at least 3 minutes in
 * that air before the correction is applied, so this blocks for ~3 minutes and
 * skips a few posts. */
void performFrc() {
  if (!scdFound) { Serial.println("No CO2 sensor."); return; }

  Serial.println("\n=== Forced recalibration ===");
  Serial.printf("Target: %u ppm. Put the sensor in fresh air and step away.\n", FRC_TARGET_PPM);

  scd4x.stopPeriodicMeasurement();
  delay(500);
  if (scd4x.startPeriodicMeasurement() != NO_ERROR) {
    Serial.println("Could not start measurement. Aborted.");
    return;
  }

  for (int remaining = 180; remaining > 0; remaining -= 10) {
    Serial.printf("  %d s remaining...\n", remaining);
    delay(10000);
  }

  scd4x.stopPeriodicMeasurement();
  delay(500);

  uint16_t correction = 0;
  int16_t error = scd4x.performForcedRecalibration(FRC_TARGET_PPM, correction);
  if (error != NO_ERROR) {
    errorToString(error, scdErrMsg, sizeof scdErrMsg);
    Serial.print("FRC failed: "); Serial.println(scdErrMsg);
  } else if (correction == 0xFFFF) {
    Serial.println("FRC failed: the sensor had not been running long enough.");
  } else {
    Serial.printf("FRC applied. Correction: %d ppm\n", (int)correction - 0x8000);
  }

  scd4x.startLowPowerPeriodicMeasurement();
  lastCo2Ppm = NAN;
  Serial.println("=== Back to normal measurement ===\n");
}

void toggleAsc() {
  if (!scdFound) { Serial.println("No CO2 sensor."); return; }

  scd4x.stopPeriodicMeasurement();
  delay(500);

  uint16_t enabled = 0;
  if (scd4x.getAutomaticSelfCalibrationEnabled(enabled) == NO_ERROR) {
    uint16_t next = enabled ? 0 : 1;
    if (scd4x.setAutomaticSelfCalibrationEnabled(next) == NO_ERROR) {
      scd4x.persistSettings();
      ascActive = (next != 0);
      Serial.printf("ASC is now %s (saved).\n", next ? "ON" : "OFF");
    }
  }
  scd4x.startLowPowerPeriodicMeasurement();
}

void printStatus() {
  Serial.println("\n--- status ---");
  Serial.printf("BME280: %s   SCD41: %s\n", bmeFound ? "ok" : "MISSING", scdFound ? "ok" : "absent");
  if (scdFound) {
    if (isnan(lastCo2Ppm)) Serial.println("CO2: no reading yet");
    else Serial.printf("CO2: %.0f ppm (%lus ago)\n", lastCo2Ppm, (millis() - lastCo2AtMs) / 1000);
    Serial.printf("ASC: %s\n", ascActive ? "on" : "off");

    // Cross-check, not data. The SCD41 normally reads a few degrees warm
    // because it heats itself; a wild disagreement means something is wrong.
    if (!isnan(lastScdTempC) && bme.takeForcedMeasurement()) {
      float delta = lastScdTempC - bme.readTemperature();
      Serial.printf("SCD41 vs BME280: %+.1f C (%.1f%% RH vs %.1f%%)%s\n",
                    delta, lastScdRh, bme.readHumidity(),
                    fabsf(delta) > 10.0f ? "   <- suspicious, check both sensors" : "");
    }
  }
  Serial.printf("WiFi: %s  RSSI %d dBm  heap %lu\n",
                WiFi.status() == WL_CONNECTED ? "connected" : "down",
                (int)WiFi.RSSI(), (unsigned long)ESP.getFreeHeap());
  Serial.printf("Last successful post: %lus ago\n", (millis() - lastSuccessfulPostMs) / 1000);
  printLocalTime();
  Serial.println("--------------\n");
}

void handleSerial() {
  if (!Serial.available()) return;
  char c = Serial.read();
  while (Serial.available()) Serial.read();   // drop the rest of the line
  switch (c) {
    case 'c': performFrc(); break;
    case 'a': toggleAsc(); break;
    case 'i': printStatus(); break;
    case 'x': scanI2C(); break;
    case 'w': scanWiFi(); break;
    default: break;
  }
}

// --------------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println("\n--- ESP32 Weather Station Booting Up ---");

  Wire.begin();
  // 100 kHz is safe for every SCD4x revision (older datasheets capped it
  // there; v1.7 raised the limit to 400 kHz). These are tiny transfers, so
  // there is nothing to gain from going faster.
  Wire.setClock(100000);

  scanI2C();

  /* BME280. Modules are strapped to 0x76 or 0x77 depending on the board, so
   * try both rather than making that a thing to debug. Retries rather than
   * hanging: a sensor that did not answer at boot used to wedge the station
   * until someone power-cycled it. */
  Serial.print("Initializing BME280...");
  uint8_t bmeAddr = 0;
  for (int attempt = 0; attempt < 5 && !bmeFound; attempt++) {
    for (uint8_t addr : { 0x76, 0x77 }) {
      if (bme.begin(addr, &Wire)) { bmeFound = true; bmeAddr = addr; break; }
    }
    if (!bmeFound) { Serial.print("."); delay(500); }
  }
  if (!bmeFound) {
    Serial.println(" not found at 0x76 or 0x77. Rebooting in 10s.");
    delay(10000);
    ESP.restart();
  }
  Serial.printf(" found at 0x%02X!\n", bmeAddr);

  /* Bosch's weather-monitoring configuration: forced mode, single sampling,
   * filter off. The library's default is continuous 16x oversampling with a
   * 0.5 ms standby, which is close to a 100% duty cycle and self-heats the die
   * enough to bias the temperature reading upward by a degree or two. */
  bme.setSampling(Adafruit_BME280::MODE_FORCED,
                  Adafruit_BME280::SAMPLING_X1,   // temperature
                  Adafruit_BME280::SAMPLING_X1,   // pressure
                  Adafruit_BME280::SAMPLING_X1,   // humidity
                  Adafruit_BME280::FILTER_OFF);

  Serial.print("Initializing SCD41 at 0x62...");
  scdFound = initScd4x();
  if (!scdFound) Serial.println("Continuing without CO2 (fields 1-4 only).");

  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  connectWiFi();

  Serial.print("Synchronizing time with NTP server...");
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm timeinfo;
  unsigned long t0 = millis();
  while (!getLocalTime(&timeinfo) && millis() - t0 < 10000) {
    Serial.print(".");
    delay(500);
  }
  Serial.println(" Time synchronized (or timeout).");
  printLocalTime();

  ThingSpeak.begin(client);
  applyClientTimeout();
  lastSuccessfulPostMs = millis();
  Serial.println("ThingSpeak communication initialized.");
  Serial.println("Serial commands: i = status, x = scan I2C, w = scan WiFi, c = recalibrate CO2, a = toggle ASC");
}

// ---------------------------------------------------------------------- loop
void loop() {
  handleSerial();
  pollCo2();          // cheap, and keeps the 30s buffer drained

  ensureWiFi();

  // Last-resort backstop: if nothing has posted in half an hour, something is
  // wedged that the reconnect logic cannot see. Reboot.
  if (millis() - lastSuccessfulPostMs > rebootIfNoPostForMs) {
    Serial.println("No successful post in 30 minutes; rebooting.");
    delay(500);
    ESP.restart();
  }

  if (WiFi.status() != WL_CONNECTED) {
    delay(100);
    return;
  }

  if (millis() - lastUpdateMs < updateIntervalMs) {
    delay(20);   // yield to the RTOS instead of spinning flat out
    return;
  }
  lastUpdateMs = millis();

  // Forced mode sleeps between readings, so ask for one and wait for it.
  if (!bme.takeForcedMeasurement()) {
    Serial.println("BME280 did not complete a measurement! Skipping update.");
    return;
  }

  float temperature = bme.readTemperature();
  float humidity    = bme.readHumidity();
  float pressurePa  = bme.readPressure();
  float pressure    = pressurePa / 100.0f;
  float altitude    = bme.readAltitude(SEALEVELPRESSURE_HPA);

  if (isnan(temperature) || isnan(humidity) || isnan(pressure) || pressurePa <= 0.0f) {
    Serial.println("Failed to read from BME280 sensor! Skipping update.");
    return;
  }

  /* Feed real barometric pressure to the SCD41. CO2 concentration is derived
   * from an optical absorption measurement that depends on gas density, so
   * without this the sensor assumes 1013 hPa and drifts with the weather —
   * which would put a pressure-shaped artefact straight into the CO2 series
   * we are trying to correlate against pressure. */
  if (scdFound) {
    uint32_t pa = (uint32_t)pressurePa;
    if (pa >= 70000 && pa <= 120000) scd4x.setAmbientPressure(pa);
  }

  bool co2Fresh = scdFound && !isnan(lastCo2Ppm) && (millis() - lastCo2AtMs) < co2MaxAgeMs;

  Serial.printf("\nReading sensors...  Temp: %.2f C  Hum: %.2f %%  Pres: %.2f hPa  Alt: %.2f m",
                temperature, humidity, pressure, altitude);
  if (co2Fresh) Serial.printf("  CO2: %.0f ppm\n", lastCo2Ppm);
  else Serial.println(scdFound ? "  CO2: waiting" : "");

  ThingSpeak.setField(1, temperature);
  ThingSpeak.setField(2, humidity);
  ThingSpeak.setField(3, pressure);
  ThingSpeak.setField(4, altitude);
  // Field 5 is left unset when there is no fresh reading, so ThingSpeak stores
  // a null rather than a stale number and the dashboard shows a gap.
  if (co2Fresh) ThingSpeak.setField(5, (int)lround(lastCo2Ppm));

  client.stop();
  delay(10);

  Serial.print("Sending data to ThingSpeak...");
  int httpCode = ThingSpeak.writeFields(myChannelNumber, myWriteAPIKey);

  if (httpCode == 200) {
    Serial.println(" Channel update successful.");
    consecutiveFailCount = 0;
    lastSuccessfulPostMs = millis();
  } else {
    Serial.printf(" Problem updating channel. HTTP error code %d\n", httpCode);

    if (httpCode == -301) {
      ensureWiFi();
      client.stop();
      delay(50);
      Serial.print("Retrying ThingSpeak update...");
      httpCode = ThingSpeak.writeFields(myChannelNumber, myWriteAPIKey);

      if (httpCode == 200) {
        Serial.println(" Channel update successful on retry.");
        consecutiveFailCount = 0;
        lastSuccessfulPostMs = millis();
      } else {
        Serial.printf(" Retry failed. HTTP code %d\n", httpCode);
        consecutiveFailCount++;
      }
    } else {
      consecutiveFailCount++;
    }

    if (consecutiveFailCount >= maxFailsBeforeWiFiReset) {
      Serial.println("Too many consecutive failures; resetting Wi-Fi stack...");
      WiFi.disconnect(true, true);
      delay(500);
      connectWiFi();
      ThingSpeak.begin(client);
      applyClientTimeout();
      consecutiveFailCount = 0;
    }
  }

  Serial.printf("Next update in %lu seconds. RSSI: %d dBm, Free heap: %lu\n",
                (unsigned long)(updateIntervalMs / 1000),
                (int)WiFi.RSSI(), (unsigned long)ESP.getFreeHeap());
}

/* Lists every access point the radio can actually hear.
 *
 * This is the one measurement that separates the three causes of a
 * "NO_AP_FOUND" (reason 201) failure, which otherwise all look identical:
 *   - your network listed, decent signal  -> not the radio; look at the
 *     password, the band, or AP-side client limits
 *   - other networks listed, yours absent -> the AP is down, renamed, or has
 *     dropped off 2.4 GHz (the ESP32 cannot see 5 GHz at all)
 *   - nothing listed                      -> the radio itself is impaired:
 *     brownout from an inadequate supply, or something detuning the antenna
 */
void scanWiFi() {
  Serial.println("Scanning for WiFi networks (a few seconds)...");
  int found = WiFi.scanNetworks();

  if (found <= 0) {
    Serial.println("  NOTHING found at all.");
    Serial.println("  The radio cannot hear any network, not just yours. That points at");
    Serial.println("  power (try a 1A+ charger rather than a PC USB port) or at something");
    Serial.println("  sitting against the ESP32's antenna.");
    return;
  }

  Serial.printf("  %d network(s):\n", found);
  bool sawOurs = false;
  for (int i = 0; i < found; i++) {
    bool ours = WiFi.SSID(i) == String(ssid);
    sawOurs |= ours;
    Serial.printf("  %-32s ch%-3d %4d dBm%s\n",
                  WiFi.SSID(i).c_str(), (int)WiFi.channel(i), (int)WiFi.RSSI(i),
                  ours ? "   <- yours" : "");
  }
  if (!sawOurs) {
    Serial.printf("  '%s' is NOT among them. Check the AP is on, still has that\n", ssid);
    Serial.println("  exact name, and is broadcasting on 2.4 GHz — the ESP32 cannot see 5 GHz.");
  }
  WiFi.scanDelete();
}

void connectWiFi(bool verbose) {
  if (verbose) {
    Serial.print("Connecting to WiFi: ");
    Serial.println(ssid);
  }
  WiFi.begin(ssid, password);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    if (verbose) Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (verbose) {
      Serial.println("\nWiFi connected!");
      Serial.print("IP Address: ");
      Serial.println(WiFi.localIP());
    }
    return;
  }

  Serial.println("\nWiFi connect timeout. Will retry in loop.");

  // Diagnose once per boot rather than on every retry: the scan is slow and
  // the answer will not change from one attempt to the next.
  static bool scannedOnce = false;
  if (!scannedOnce) {
    scannedOnce = true;
    scanWiFi();
  }
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("WiFi not connected. Reconnecting");
  WiFi.reconnect();
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 5000) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nQuick reconnect failed, doing full reconnect...");
    WiFi.disconnect(true, true);
    delay(300);
    connectWiFi(false);
  } else {
    Serial.println(" ok.");
  }
}
