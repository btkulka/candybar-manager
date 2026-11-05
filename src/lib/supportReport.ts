// The support report (Settings → Save a report): what goes in it, minus
// anything personal.

/** Personal details out of a report's copy of a log: the gate fields (older
 *  builds logged them with every settings save), escaped or not, and any
 *  email address anywhere. */
export function scrubForReport(text: string): string {
  return text
    .replace(/(\\?"(?:gate(?:Email|FirstName|LastName|AddressLine1|City|Region|Postcode|Country)|e-?mail)\\?"\s*:\s*\\?")((?:[^"\\]|\\(?!"))*)(\\?")/gi, '$1[redacted]$3')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
}
