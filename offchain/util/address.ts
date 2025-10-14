import { Address } from 'viem';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(addr: string | undefined | null): addr is string {
  if (!addr) return false;
  return ADDRESS_REGEX.test(addr.trim());
}

export function normalizeAddress(addr: string): Address {
  let a = (addr ?? '').trim();
  if (!a.startsWith('0x') && !a.startsWith('0X')) {
    a = `0x${a}`;
  }
  let hex = a.slice(2).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  if (hex.length < 40) {
    hex = hex.padStart(40, '0');
  } else if (hex.length > 40) {
    hex = hex.slice(-40);
  }
  return (`0x${hex}`) as Address;
}
