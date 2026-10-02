import {
  pinMode,
  delay,
  interruptOn,
  INPUT_PULLUP,
  CHANGED,
} from './arduino';

const PAUSE: u32 = 1000;
const BIG_BTN: u8 = 37;

let gTimeMilliSecond: f32 = 0.0;
let gTimeSecond: f32 = 0.0;
const second: f32 = 22;
const ms: f32 = 3000.2
let tmpMS: f32 = 0.0;
let gOrbitLastCtrlTime: f32 = 0.0;


function setupHardware(): void {
  pinMode(BIG_BTN, INPUT_PULLUP);
  interruptOn(BIG_BTN, CHANGED, intM1553B);
}

function intM1553B(topic_start: u32,topic_len: u32,mem_start: u32,payload_len: u32,payload_len2: u32,
): void {
  //...
  gTimeSecond = second + ms/ 1000;
  gTimeMilliSecond =  ms % 1000;
  // ...
}

export function main(): void {
  setupHardware();
  while (true) {
    // ...
    // normally tmpMs all as one line
    tmpMS = gTimeSecond * 1000;
    intM1553B(0,0,0,0,0); // interrupt triggered
    tmpMS = tmpMS + gTimeMilliSecond +
      gOrbitLastCtrlTime;
    delay(PAUSE);
  }
}
