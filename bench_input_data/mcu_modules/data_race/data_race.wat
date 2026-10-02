
(module
  (type $i32->i32->void (func (param i32 i32)))
  (type $i32->i32->i32->void (func (param i32 i32 i32)))
  (type $callback (func (param i32 i32 i32 i32 i32)))
  (type $i32->void (func (param i32)))
  (type $void->void (func))
  (type $void->f64 (func (param) (result f64)))
  (type $void->f32 (func (param) (result f32)))

  (import "env" "chip_pin_mode" (func $env.chip_pin_mode (type $i32->i32->void)))
  (import "env" "chip_delay" (func $env.chip_delay (type $i32->void)))
  (import "env" "subscribe_interrupt" (func $env.subscribe_interrupt (type $i32->i32->i32->void)))

  ;; Hardware Config
  (global $BIG_BUTTON i32 (i32.const 37))
  (global $INPUT_PULL_UP i32 (i32.const 5))
  (global $ON_CHANGE i32 (i32.const 1))


  (global $currentTemp (mut f32) (f32.const 0))
  (global $addressTemp i32 (i32.const 0))


  (func $setupHardware
    global.get $BIG_BUTTON
    global.get $INPUT_PULL_UP
    call $env.chip_pin_mode

    global.get $BIG_BUTTON
    i32.const 0 ;; index of $displayTemp in table
    global.get $ON_CHANGE
    call $env.subscribe_interrupt
  )

  (func $readTemp (type $void->f32)
    ;; assuming this is an environment call
    f32.const 27.33
  )

  ;; triggered on buttonPress
  (func $displayTemp (type $callback)
    ;; push address of currentTemp in the linear memory
    global.get $addressTemp

    ;; call env function to display on screen
    drop
  )

  (func $updateTemp (type $void->void)
    call $readTemp ;; pushes f32 value on stack
    global.set $currentTemp 
  )
 
  ;; Writes $currentTemp to linear memory at $addressTemp in reversed
  ;; ("big endian") byte order relative to Wasm's native little-endian
  ;; layout, using two separate, non-atomic 16-bit stores. That split
  ;; is intentional for this example: a concurrent reader could observe
  ;; memory between the two stores and see a torn/partially-written value.
  (func $writeTempToMem (type $void->void)
    (local $temp i32)
    (local $high i32)
    (local $low i32)

    ;; reinterpret $currentTemp (f32) as its raw 32-bit representation
    ;; (no numeric conversion, just relabels the same bits as an i32)
    global.get $currentTemp
    i32.reinterpret_f32
    local.set $temp

    ;; assign high 16 bits, i.e. bytes 2..3 to $high
    ;; (unsigned shift so the top is zero-filled)
    local.get $temp
    i32.const 16
    i32.shr_u
    local.set $high

    ;; assign low 16 bits, i.e. bytes 0..1 to $low
    ;; Wasm is Little endian i.e., Lowest value at lowest address
    local.get $temp
    i32.const 0xFFFF
    i32.and
    local.set $low

    ;; store last two bytes (2 3) at $addressTemp
    ;; push destination address first, it stays under the value on the stack
    global.get $addressTemp
    ;; byte-swap $high within its own halfword: (high >> 8) puts byte 3
    ;; in the low byte position, (high << 8) puts byte 2 in the high
    ;; byte position, then i32.or combines them
    local.get $high
    i32.const 8
    i32.shr_u
    local.get $high
    i32.const 8
    i32.shl
    i32.or
    ;; write 2 bytes at $addressTemp: addr = byte 3, addr+1 = byte 2
    i32.store16

    ;; store first two bytes (0 1) at $addressTemp + 2
    ;; address = 2 + $addressTemp (operand order doesn't matter, i32.add is commutative)
    global.get $addressTemp
    i32.const 2
    i32.add
    ;; byte-swap $low the same way: byte 1 into the low position,
    ;; byte 0 into the high position
    local.get $low
    i32.const 8
    i32.shr_u
    local.get $low
    i32.const 8
    i32.shl
    i32.or
    ;; write 2 bytes at $addressTemp+2: addr+2 = byte 1, addr+3 = byte 0
    i32.store16
  )

  (func $main (export "main")
	  call $setupHardware
    loop $endless
		  call $updateTemp
      call $writeTempToMem

      i32.const 0
      i32.const 0
      i32.const 0
      i32.const 0
      i32.const 0
      call $displayTemp

      ;; sleep 500 milliseconds
		  i32.const 500
		  call $env.chip_delay
		  br $endless
	  end
  )

  (memory (export "memory") 1)
  (table 1 funcref)
  (elem (i32.const 0) func $displayTemp)
)
