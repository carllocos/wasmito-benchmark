import {
  pinMode,
  delay,
  interruptOn,
  INPUT_PULLUP,
  CHANGED,
} from './arduino';

const PAUSE: u32 = 1000;
const BIG_BTN: u8 = 37;
let tyroL: f32 = 35.2;
let tyroP: f32 = 2.3;
let tyroL1: f32 = 1.4;
let FILA1_100HZ: f32 = 1.0;
let FILA2_100HZ: f32 = 2.1;
let setLoop: f32 = 30.2;
let vErrorMax: f32 = 2.0;

function setupHardware(): void {
  pinMode(BIG_BTN, INPUT_PULLUP);
  interruptOn(BIG_BTN, CHANGED, receiveFromGYRO);
}

function receiveFromGYRO(topic_start: u32,topic_len: u32,mem_start: u32,payload_len: u32,payload_len2: u32,
): void {
  //...
  tyroL = FILA1_100HZ * tyroP + FILA2_100HZ * tyroL1;
  // ...
}

export function main(): void {
  setupHardware();
  while (true) {
    // ...
    if(abs(setLoop - tyroL) > vErrorMax){
      // ...
      receiveFromGYRO(0,0,0,0,0); // interrupt triggered
      vErrorMax = abs(setLoop - tyroL);
      // ...
    }
    // ...
    delay(PAUSE);
  }
}
