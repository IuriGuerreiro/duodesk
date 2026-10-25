let held: string | undefined;

/** Passes a paired invitation to the screen that uses it, keeping its token out of route params. */
export const holdInvitation = (invitation: string) => {
  held = invitation;
};

export const takeInvitation = (): string | undefined => {
  const invitation = held;
  held = undefined;
  return invitation;
};
