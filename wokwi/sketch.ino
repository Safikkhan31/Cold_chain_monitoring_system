/*
  Cold chain box firmware (ESP32), built for the Wokwi simulator.

  Parts:  DS18B20 (temperature, works below 0 C)   DHT22 (humidity)
          MPU6050 (vibration, shock, tilt)         HC-SR04 + LDR module + slide switch (lid open)
          SSD1306 OLED (status screen)             green / red LED + buzzer (local alarm)
  The BN-880 GPS does not exist in Wokwi, so the position is simulated (a truck driving from Ahmedabad to Mumbai).

  Wokwi libraries.txt: PubSubClient, ArduinoJson, DHT sensor library, Adafruit Unified Sensor, OneWire,
                       DallasTemperature, Adafruit MPU6050, Adafruit SSD1306, Adafruit GFX Library

  Pins:  DS18B20 DQ -> 27 (4.7k pull-up to 3V3)   DHT22 SDA -> 4     LDR AO -> 34
         HC-SR04 TRIG -> 25, ECHO -> 26           Lid switch -> 14   (slide left = closed, right = open)
         MPU6050 + OLED: SDA -> 21, SCL -> 22     Green LED -> 32, Red LED -> 33, Buzzer -> 13
*/
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

// ---- CONFIGURE THESE ----
const char* WIFI_SSID   = "Wokwi-GUEST";          // Wokwi's built-in Wi-Fi
const char* WIFI_PASS   = "";
const char* MQTT_HOST   = "YOUR_MQTT_HOST";       // terraform output -raw mqtt_host
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = "esp32";
const char* MQTT_PASS   = "YOUR_MQTT_PASSWORD";   // terraform output -raw mqtt_esp32_password
const char* BOX_ID      = "BOX-001";
const int   INTERVAL_S  = 10;                     // seconds between readings

// Local alarm range (the dashboard uses the limits stored in the database)
const float SAFE_MIN_C = 2.0;
const float SAFE_MAX_C = 8.0;

// Lid detection thresholds. The first readings at start-up are the "closed" reference.
const int   LIGHT_DELTA   = 400;                  // ADC change that counts as light getting in
const float DIST_DELTA_CM = 10.0;                 // distance change that counts as the lid moving
const float MOVING_KMPH   = 2.0;

#define DHT_TYPE DHT22                            // real hardware with a DHT11: use DHT11
// -------------------------

#define PIN_DS18B20 27
#define PIN_DHT      4
#define PIN_LDR     34
#define PIN_TRIG    25
#define PIN_ECHO    26
#define PIN_LID     14
#define PIN_LED_G   32
#define PIN_LED_R   33
#define PIN_BUZZ    13
#define QMAX        60                            // readings kept in RAM while offline

OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);
DHT dht(PIN_DHT, DHT_TYPE);
Adafruit_MPU6050 mpu;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
WiFiClient net;
PubSubClient mqtt(net);

bool mpuOk = false, oledOk = false;
String topic;
String queue[QMAX];
int qHead = 0, qCount = 0;
unsigned long lastSample = 0, lastRetry = 0;
int baseLight = 0;
float baseDist = -1;
float simProgress = 0;                            // simulated GPS position along the route

// ---------- offline queue ----------
void enqueue(const String& s) {
  if (qCount == QMAX) { qHead = (qHead + 1) % QMAX; qCount--; }   // drop oldest
  queue[(qHead + qCount) % QMAX] = s;
  qCount++;
}

void flushQueue() {
  while (qCount > 0 && mqtt.connected()) {
    if (!mqtt.publish(topic.c_str(), queue[qHead].c_str())) return;
    qHead = (qHead + 1) % QMAX; qCount--;
    mqtt.loop();
  }
}

void ensureConnections() {
  if (millis() - lastRetry < 5000) return;
  lastRetry = millis();
  if (WiFi.status() != WL_CONNECTED) { WiFi.begin(WIFI_SSID, WIFI_PASS); return; }
  if (!mqtt.connected()) {
    String cid = String("esp32-") + BOX_ID;
    if (mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS)) Serial.println("MQTT connected");
    else Serial.printf("MQTT failed, rc=%d\n", mqtt.state());
  }
}

// ---------- sensors ----------
int readLight() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(PIN_LDR); delay(2); }
  return (int)(sum / 16);
}

float distanceOnce() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);
  if (us == 0) return -1;                         // no echo
  return us * 0.0343f / 2.0f;                     // cm
}

float readDistance() {                            // median of 3
  float v[3];
  for (int i = 0; i < 3; i++) { v[i] = distanceOnce(); delay(60); }
  if (v[0] > v[1]) { float t = v[0]; v[0] = v[1]; v[1] = t; }
  if (v[1] > v[2]) { float t = v[1]; v[1] = v[2]; v[2] = t; }
  if (v[0] > v[1]) { float t = v[0]; v[0] = v[1]; v[1] = t; }
  return v[1];
}

// Peak vibration (g, gravity removed), tilt from upright (degrees) and whether the box moved
void readMotion(float& vibPeak, float& tiltDeg, bool& moved) {
  vibPeak = 0; tiltDeg = 0; moved = false;
  if (!mpuOk) return;
  const int N = 40;
  float peak = 0, gyroMax = 0, sx = 0, sy = 0, sz = 0;
  for (int i = 0; i < N; i++) {
    sensors_event_t a, g, t;
    mpu.getEvent(&a, &g, &t);
    float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
    float mag = sqrtf(ax * ax + ay * ay + az * az) / 9.81f;
    peak = max(peak, fabsf(mag - 1.0f));
    gyroMax = max(gyroMax, fabsf(g.gyro.x) + fabsf(g.gyro.y) + fabsf(g.gyro.z));
    sx += ax; sy += ay; sz += az;
    delay(10);
  }
  float mx = sx / N, my = sy / N, mz = sz / N;
  float m = sqrtf(mx * mx + my * my + mz * mz);
  if (m > 0.1f) tiltDeg = acosf(constrain(mz / m, -1.0f, 1.0f)) * 180.0f / PI;
  vibPeak = peak;
  moved = (peak > 0.05f) || (gyroMax > 0.3f);
}

// Simulated GPS: Ahmedabad (23.0225, 72.5714) to Mumbai (19.0760, 72.8777)
void simulateGps(double& lat, double& lng, float& speedKmph) {
  simProgress += 0.004f;
  if (simProgress > 1.0f) simProgress = 0;
  lat = 23.0225 + (19.0760 - 23.0225) * simProgress;
  lng = 72.5714 + (72.8777 - 72.5714) * simProgress;
  speedKmph = 40.0f + random(0, 200) / 10.0f;
}

void beep() {                                     // about 100 ms at 2 kHz, works on any ESP32 core version
  for (int i = 0; i < 200; i++) {
    digitalWrite(PIN_BUZZ, HIGH); delayMicroseconds(250);
    digitalWrite(PIN_BUZZ, LOW);  delayMicroseconds(250);
  }
}

void drawStatus(float temp, float hum, bool lidOpen, float tilt, bool alarm) {
  if (!oledOk) return;
  char line[32];
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);  oled.print(BOX_ID);
  snprintf(line, sizeof(line), "Temp %.1f C", temp);
  oled.setCursor(0, 14); oled.print(line);
  snprintf(line, sizeof(line), "Humidity %.0f %%", isnan(hum) ? 0.0f : hum);
  oled.setCursor(0, 26); oled.print(line);
  snprintf(line, sizeof(line), "Lid %s  Tilt %.0f", lidOpen ? "OPEN" : "closed", tilt);
  oled.setCursor(0, 38); oled.print(line);
  oled.setCursor(0, 52); oled.print(alarm ? "ALERT: out of range" : "Status: OK");
  oled.display();
}

// ---------- read everything, publish ----------
void sampleAndSend() {
  ds18b20.requestTemperatures();
  float temp = ds18b20.getTempCByIndex(0);
  float hum  = dht.readHumidity();
  if (temp == DEVICE_DISCONNECTED_C) temp = dht.readTemperature();   // fall back to the DHT
  if (isnan(temp)) { Serial.println("No temperature reading, skipping"); return; }

  float vib, tilt; bool moved;
  readMotion(vib, tilt, moved);

  int light = readLight();
  float dist = readDistance();
  bool switchOpen = digitalRead(PIN_LID) == HIGH;                    // slide switch right = open
  bool lightOpen  = abs(light - baseLight) > LIGHT_DELTA;
  bool distOpen   = baseDist > 0 && (dist < 0 || fabsf(dist - baseDist) > DIST_DELTA_CM);
  bool lidOpen    = switchOpen || lightOpen || distOpen;

  double lat, lng; float speedKmph;
  simulateGps(lat, lng, speedKmph);
  bool moving = moved || speedKmph > MOVING_KMPH;

  bool alarm = temp < SAFE_MIN_C || temp > SAFE_MAX_C;
  digitalWrite(PIN_LED_G, alarm ? LOW : HIGH);
  digitalWrite(PIN_LED_R, alarm ? HIGH : LOW);
  drawStatus(temp, hum, lidOpen, tilt, alarm);

  StaticJsonDocument<512> doc;
  doc["box_id"] = BOX_ID;
  time_t now = time(nullptr);
  doc["ts"] = (now > 1600000000) ? (long)now : 0;    // 0 = clock not synced, server uses its own time
  doc["temp_c"] = serialized(String(temp, 2));
  if (!isnan(hum)) doc["hum_pct"] = serialized(String(hum, 0));
  doc["vib_g"] = serialized(String(vib, 3));
  doc["tilt_deg"] = serialized(String(tilt, 1));
  doc["moving"] = moving;
  doc["lid_open"] = lidOpen;
  doc["interval_s"] = INTERVAL_S;
  doc["rssi"] = WiFi.RSSI();
  doc["light_raw"] = light;
  if (dist >= 0) doc["distance_cm"] = serialized(String(dist, 1));
  doc["lat"] = serialized(String(lat, 6));
  doc["lng"] = serialized(String(lng, 6));
  doc["speed_kmph"] = serialized(String(speedKmph, 1));

  String json;
  serializeJson(doc, json);
  Serial.println(json);
  enqueue(json);                                     // always queue, then flush
  flushQueue();

  if (alarm) beep();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_LID, INPUT_PULLUP);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_BUZZ, OUTPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_LDR, ADC_11db);

  Wire.begin(21, 22);
  mpuOk = mpu.begin();
  if (mpuOk) mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  else Serial.println("MPU6050 not found");
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("OLED not found");
  ds18b20.begin();
  dht.begin();
  delay(1000);

  baseLight = readLight();                           // "lid closed" reference
  baseDist  = readDistance();
  Serial.printf("Reference: light=%d, distance=%.1f cm\n", baseLight, baseDist);

  topic = String("coldchain/") + BOX_ID + "/telemetry";
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(768);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(300);
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // UTC timestamps
}

void loop() {
  ensureConnections();
  mqtt.loop();
  if (millis() - lastSample >= (unsigned long)INTERVAL_S * 1000UL) {
    lastSample = millis();
    sampleAndSend();
  }
  if (mqtt.connected()) flushQueue();
}
