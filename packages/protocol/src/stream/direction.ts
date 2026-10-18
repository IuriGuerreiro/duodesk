export const DIRECTIONS = ["phone-to-desktop", "desktop-to-phone"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type Role = "desktop" | "phone";
export type SignalType =
  "pair" | "paired" | "offer" | "answer" | "candidate" | "stop";

/**
 * Who may send which message once paired. The offerer is the device that shares
 * its screen. The direction-independent handshake (`pair`, `paired`) is not
 * listed, so it is rejected after the session is established.
 */
export const SIGNAL_ROUTES: Record<
  Direction,
  Record<Role, readonly SignalType[]>
> = {
  "phone-to-desktop": {
    phone: ["offer", "candidate", "stop"],
    desktop: ["answer", "candidate", "stop"],
  },
  "desktop-to-phone": {
    phone: ["answer", "candidate", "stop"],
    desktop: ["offer", "candidate", "stop"],
  },
};

export const isDirection = (value: unknown): value is Direction =>
  DIRECTIONS.some((direction) => direction === value);

export const canSend = (direction: Direction, from: Role, type: SignalType) =>
  SIGNAL_ROUTES[direction][from].includes(type);
