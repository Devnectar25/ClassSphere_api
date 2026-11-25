// Lets node run the TypeScript sources directly: resolves the "@/…" path alias and Next's extensionless entry points.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const src = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) {
            const base = join(src, specifier.slice(2));
            const file = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
            if (file) return next(pathToFileURL(file).href, context);
        }
        if (specifier === 'next/server') return next('next/server.js', context);
        return next(specifier, context);
    },
});
