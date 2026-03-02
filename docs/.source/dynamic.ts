// @ts-nocheck
import { dynamic } from 'fumadocs-mdx/runtime/dynamic';
import * as Config from '../source.config';

const create = await dynamic<
  typeof Config,
  import('fumadocs-mdx/runtime/types').InternalTypeConfig & {
    DocData: {};
  } & {
    DocData: {
      docs: {
        /**
         * Last modified date of document file, obtained from version control.
         *
         */
        lastModified?: Date;
      };
    };
  }
>(
  Config,
  { environment: 'next', outDir: '.source', configPath: 'source.config.ts' },
  { doc: { passthroughs: ['extractedReferences', 'lastModified'] } }
);
