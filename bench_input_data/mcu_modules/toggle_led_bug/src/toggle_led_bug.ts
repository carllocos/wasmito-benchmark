import {
  pinMode,
  delay,
  interruptOn,
  INPUT_PULLUP,
  CHANGED,
  digitalWrite,
  OUTPUT,
} from './arduino';

const PAUSE: u32 = 100;
const BIG_BTN: u8 = 37;
const LED: u8 = 10;
let LED_OFF: u8;
let LED_ON: u8;

const PRESSES_NEEDED: u8 = 5;
let presses: u8;
let ledOn: boolean;

function setupHardware(): void {
  ledOn = false;
  LED_ON = 0;
  LED_OFF = 1;
  pinMode(LED, OUTPUT);
  digitalWrite(LED, LED_OFF); // by default LED OFF
  pinMode(BIG_BTN, INPUT_PULLUP);
  interruptOn(BIG_BTN, CHANGED, toggleLed);
}

function toggleLed(topic_start: u32,topic_len: u32,mem_start: u32,payload_len: u32,payload_len2: u32,
): void {
  if(presses <= 0){
    ledOn = !ledOn;
    digitalWrite(LED, ledOn ? LED_ON : LED_OFF);
    presses = PRESSES_NEEDED;
    return;
  }
  presses--;
}

export function main(): void {
  setupHardware();
  toggleLed(0,0,0,0,0); // Manually call interrupt handler
  presses = PRESSES_NEEDED;
  while (true) {
    delay(PAUSE);
  }
}