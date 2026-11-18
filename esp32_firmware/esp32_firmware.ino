/*
  Cold chain box firmware (ESP32) for: DHT11, BN-880 (GPS + compass), HC-SR04, HW-072 (LDR light module)

  Libraries (Library Manager): PubSubClient, ArduinoJson, DHT sensor library (Adafruit),
                               Adafruit Unified Sensor, TinyGPSPlus

  Wiring:
    DHT11   DATA -> GPIO4,  VCC -> 3V3, GND -> GND
    BN-880  GPS TX -> GPIO16 (ESP32 RX2), GPS RX -> GPIO17 (ESP32 TX2), VCC -> 5V (or 3V3), GND -> GND
    BN-880  compass SDA -> GPIO21, SCL -> GPIO22 (same I2C pins)
    HC-SR04 TRIG -> GPIO25, VCC -> 5V, GND -> GND
            ECHO -> GPIO26 THROUGH A VOLTAGE DIVIDER (ECHO -> 1k -> GPIO26, GPIO26 -> 2k -> GND). ECHO is 5 V, the ESP32 is 3.3 V.
    HW-072  AO -> GPIO34, VCC -> 3V3, GND -> GND

  How it maps to the cold chain checks:
    temperature, humidity -> DHT11
    lid open              -> HW-072 sees light inside the box, and/or HC-SR04 distance to the lid changes
    location, speed       -> BN-880 GPS
    movement              -> GPS speed, or compass heading jump
  There is no vibration sensor, so vib_g is always 0 and shock events are never counted.
  Power the box with the lid CLOSED: the light level and distance at boot are used as the "closed" reference.
*/
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <time.h>

// ---- CONFIGURE THESE ----
const char* WIFI_SSID   = "YOUR_WIFI";
const char* WIFI_PASS   = "YOUR_PASSWORD";
const char* MQTT_HOST   = "YOUR_MQTT_HOST";       // terraform output mqtt_host
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = "esp32";
const char* MQTT_PASS   = "YOUR_MQTT_PASSWORD";   // terraform output -raw mqtt_esp32_password
const char* BOX_ID      = "BOX-001";              // unique per box
const int   INTERVAL_S  = 10;                     // seconds between readings

// ---- Detection thresholds (tune after testing) ----
const int   LIGHT_DELTA            = 400;     // ADC change (0-4095) that counts as light getting in
const float DIST_DELTA_CM          = 10.0;    // distance change that counts as the lid moving
const bool  USE_ULTRASONIC_FOR_LID = true;    // set false if the HC-SR04 is used for something else
const float MOVING_KMPH            = 2.0;     // GPS speed above this = moving
const float HEADING_JUMP_DEG       = 25.0;    // compass heading change that counts as movement
// -------------------------

#define PIN_DHT   4
#define PIN_TRIG  25
#define PIN_ECHO  26
#define PIN_LDR   34
#define GPS_RX    16
#define GPS_TX    17
#define QMAX      60                          // readings kept in RAM while offline

DHT dht(PIN_DHT, DHT11);
TinyGPSPlus gps;
WiFiClient net;
PubSubClient mqtt(net);

String topic;
String queue[QMAX];
int qHead = 0, qCount = 0;
unsigned long lastSample = 0, lastRetry = 0;
int baseLight = 0;
float baseDist = -1;
float lastHeading = -1;
enum CompassType { C_NONE, C_QMC, C_HMC };
CompassType compass = C_NONE;

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
void feedGps() {
  while (Serial2.available()) gps.encode(Serial2.read());
}

int readLight() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(PIN_LDR); delay(2); }
  return (int)(sum / 16);
}

float distanceOnce() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);   // 30 ms timeout (about 5 m)
  if (us == 0) return -1;                              // no echo
  return us * 0.0343f / 2.0f;                          // cm
}

float readDistance() {                                 // median of 3 readings
  float v[3];
  for (int i = 0; i < 3; i++) { v[i] = distanceOnce(); delay(60); }
  if (v[0] > v[1]) { float t = v[0]; v[0] = v[1]; v[1] = t; }
  if (v[1] > v[2]) { float t = v[1]; v[1] = v[2]; v[2] = t; }
  if (v[0] > v[1]) { float t = v[0]; v[0] = v[1]; v[1] = t; }
  return v[1];
}

bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void i2cWrite(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.write(val); Wire.endTransmission();
}

bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(addr); Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom((uint8_t)addr, (uint8_t)n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// BN-880 boards carry either a QMC5883L (0x0D) or an HMC5883L (0x1E) compass chip
void compassBegin() {
  if (i2cPresent(0x0D)) {
    compass = C_QMC;
    i2cWrite(0x0D, 0x0B, 0x01);
    i2cWrite(0x0D, 0x09, 0x1D);
  } else if (i2cPresent(0x1E)) {
    compass = C_HMC;
    i2cWrite(0x1E, 0x00, 0x70);
    i2cWrite(0x1E, 0x01, 0x20);
    i2cWrite(0x1E, 0x02, 0x00);
  }
  Serial.printf("Compass: %s\n", compass == C_QMC ? "QMC5883L" : compass == C_HMC ? "HMC5883L" : "not found");
}

float readHeading() {                                  // degrees 0-360, or -1 if unavailable
  uint8_t b[6];
  int16_t x, y;
  if (compass == C_QMC) {
    if (!readRegs(0x0D, 0x00, b, 6)) return -1;
    x = (int16_t)((b[1] << 8) | b[0]);
    y = (int16_t)((b[3] << 8) | b[2]);
  } else if (compass == C_HMC) {
    if (!readRegs(0x1E, 0x03, b, 6)) return -1;
    x = (int16_t)((b[0] << 8) | b[1]);
    y = (int16_t)((b[4] << 8) | b[5]);
  } else {
    return -1;
  }
  float h = atan2((float)y, (float)x) * 180.0f / PI;
  if (h < 0) h += 360.0f;
  return h;
}

// ---------- read everything, publish ----------
void sampleAndSend() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  if (isnan(temp)) { Serial.println("DHT11 read failed, skipping this reading"); return; }

  int light     = readLight();
  float dist    = readDistance();
  float heading = readHeading();

  bool lightOpen = abs(light - baseLight) > LIGHT_DELTA;
  bool distOpen  = USE_ULTRASONIC_FOR_LID && baseDist > 0 && (dist < 0 || fabsf(dist - baseDist) > DIST_DELTA_CM);
  bool lidOpen   = lightOpen || distOpen;

  bool headingJump = false;
  if (heading >= 0 && lastHeading >= 0) {
    float d = fabsf(heading - lastHeading);
    if (d > 180) d = 360 - d;
    headingJump = d > HEADING_JUMP_DEG;
  }
  if (heading >= 0) lastHeading = heading;
  bool moving = headingJump || (gps.speed.isValid() && gps.speed.kmph() > MOVING_KMPH);

  StaticJsonDocument<512> doc;
  doc["box_id"] = BOX_ID;
  time_t now = time(nullptr);
  doc["ts"] = (now > 1600000000) ? (long)now : 0;    // 0 = clock not synced, server uses its own time
  doc["temp_c"] = serialized(String(temp, 1));
  if (!isnan(hum)) doc["hum_pct"] = serialized(String(hum, 0));
  doc["vib_g"] = 0;                                  // no vibration sensor on this box
  doc["moving"] = moving;
  doc["lid_open"] = lidOpen;
  doc["interval_s"] = INTERVAL_S;
  doc["rssi"] = WiFi.RSSI();
  doc["light_raw"] = light;
  if (dist >= 0) doc["distance_cm"] = serialized(String(dist, 1));
  if (heading >= 0) doc["heading_deg"] = serialized(String(heading, 0));
  if (gps.location.isValid()) {
    doc["lat"] = serialized(String(gps.location.lat(), 6));
    doc["lng"] = serialized(String(gps.location.lng(), 6));
  }
  if (gps.speed.isValid()) doc["speed_kmph"] = serialized(String(gps.speed.kmph(), 1));

  String json;
  serializeJson(doc, json);
  Serial.println(json);
  enqueue(json);                                     // always queue, then flush
  flushQueue();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_LDR, ADC_11db);

  Serial2.setRxBufferSize(1024);                     // GPS sends a lot while we are busy reading sensors
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Wire.begin(21, 22);
  compassBegin();
  dht.begin();
  delay(2000);                                       // let the DHT11 settle

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
  feedGps();
  ensureConnections();
  mqtt.loop();
  if (millis() - lastSample >= (unsigned long)INTERVAL_S * 1000UL) {
    lastSample = millis();
    sampleAndSend();
  }
  if (mqtt.connected()) flushQueue();
}
