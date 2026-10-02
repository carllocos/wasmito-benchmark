@external("env", "chip_delay") declare function chip_delay(ms: u32): void;
@external("env", "chip_pin_mode") declare function chip_pin_mode(pin: u8, mode: u8): void;
@external("env", "chip_digital_write") declare function chip_digital_write(pin: u8, value: u8): void;
@external("env", "subscribe_interrupt") declare function subscribe_interrupt(mode: u8, fn:  u32, pin: u8): void;
@external("env", "subscribe_enable") declare function subscribe_enable(): void;
@external("env", "subscribe_disable") declare function subscribe_disable(): void;

export function pinMode(pin: u8, mode: u8): void {
    chip_pin_mode(pin, mode);
}

export function digitalWrite(pin: u8, value: u8): void {
    chip_digital_write(pin, value);
}

export function delay(ms: u32): void {
    chip_delay(ms);
}


export function interruptOn(pin: u8, mode: u8, fn: (topic_start: u32, topic_len: u32, mem_start: u32,  payload_len: u32, payload_len2: u32) => void): void {
    subscribe_interrupt(pin, fn.index, mode);
}

export function interruptEnable(): void{
    subscribe_enable();
}

export function interruptDisable(): void{
    subscribe_disable();
}

export const OUTPUT: u8 = 2;
export const INPUT: u8 = 1; // or 0
export const INPUT_PULLUP: u8 = 5;

export const HIGH: u8 = 1;
export const LOW: u8 = 0;

export const CHANGED: u8 = 1; //TODO confirm type
export const FALLING: u8 = 2;
export const RISING: u8 = 3;
