import { describe, it, expect } from 'vitest';
import { scrubForReport } from '../supportReport';

describe('scrubForReport', () => {
  it('blanks the gate details older builds logged, plain or escaped inside a tool result', () => {
    expect(scrubForReport('{"gateEmail":"sam@x.com","gateFirstName":"Sam","gatePostcode":"78701","key":"8A"}'))
      .toBe('{"gateEmail":"[redacted]","gateFirstName":"[redacted]","gatePostcode":"[redacted]","key":"8A"}');
    expect(scrubForReport('"text": "{\\n \\"gateLastName\\": \\"Rivera\\", \\"title\\": \\"Go Back\\"}"'))
      .toBe('"text": "{\\n \\"gateLastName\\": \\"[redacted]\\", \\"title\\": \\"Go Back\\"}"');
  });

  it('turns any email address into [email], and leaves the rest alone', () => {
    expect(scrubForReport('[info] Qobuz account ben@example.vip signed in; comment "dis shit nasty"'))
      .toBe('[info] Qobuz account [email] signed in; comment "dis shit nasty"');
    expect(scrubForReport('{"email":"x@y.co","label":"Primary"}')).toBe('{"email":"[redacted]","label":"Primary"}');
  });
});
