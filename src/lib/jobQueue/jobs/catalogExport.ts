import { JobDefinition } from '../types';
import { exportCatalog } from '../../catalogExport';

type CatalogExportParams = {
  libraryRoot: string;
  outputPath: string;
  contextKey: string;
};

type CatalogExportResult = {
  total: number;
  exported: number;
  skipped: number;
};

export const catalogExportJob: JobDefinition<CatalogExportParams, CatalogExportResult> = {
  type: 'catalog-export',
  dependencies: ['library-file-list'],

  async run(ctx) {
    const { libraryRoot, outputPath } = ctx.params;
    const fileList = ctx.getSharedResult('library-file-list');

    const result = await exportCatalog(
      libraryRoot,
      outputPath,
      ctx.log,
      (current, total, message) => {
        ctx.progress({ phase: 'exporting', current, total, message });
      },
      fileList?.files
    );

    return result;
  }
};
