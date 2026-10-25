/** The integer operations used by @swan-io/srp, using Hermes's native BigInt. */
export class BigInteger {
  readonly value: bigint;

  constructor(value: string | bigint, radix = 10) {
    this.value =
      typeof value === "bigint"
        ? value
        : BigInt(radix === 16 ? `0x${value}` : value);
  }

  add(other: BigInteger): BigInteger {
    return new BigInteger(this.value + other.value);
  }

  subtract(other: BigInteger): BigInteger {
    return new BigInteger(this.value - other.value);
  }

  multiply(other: BigInteger): BigInteger {
    return new BigInteger(this.value * other.value);
  }

  xor(other: BigInteger): BigInteger {
    return new BigInteger(this.value ^ other.value);
  }

  equals(other: BigInteger): boolean {
    return this.value === other.value;
  }

  mod(other: BigInteger): BigInteger {
    const remainder = this.value % other.value;
    return new BigInteger(remainder < 0n ? remainder + other.value : remainder);
  }

  modPow(exponent: BigInteger, modulus: BigInteger): BigInteger {
    let power = exponent.value;
    let base = this.mod(modulus).value;
    let result = 1n;
    while (power > 0n) {
      if (power & 1n) result = (result * base) % modulus.value;
      power >>= 1n;
      base = (base * base) % modulus.value;
    }
    return new BigInteger(result);
  }

  toString(radix = 10): string {
    return this.value.toString(radix);
  }
}
