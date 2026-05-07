import { scanUsbHealth } from '../../usbHealthScan';
import type { JobDefinition } from '../types';
import type { UsbHealthResult } from '../../../types';

type UsbHealthParams = {
  volumePath: string;
};

export const usbHealthScanJob: JobDefinition<UsbHealthParams, UsbHealthResult> = {
  type: 'usb-health-scan',
  dependencies: [],

  async run(ctx) {
    return scanUsbHealth(ctx.params.volumePath, (p) => {
      ctx.progress({
        phase: p.phase,
        current: p.current,
        total: p.total,
        message: `${p.phase}: ${p.current}/${p.total}`,
        detail: p.currentFile
      });
    });
  }
};
