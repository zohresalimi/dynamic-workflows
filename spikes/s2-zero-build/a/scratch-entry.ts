// AC3's scratch entry: a `vite build` target that imports "@spike/b" so the
// bundler's resolution across the workspace symlink is exercised too.
import { message } from '@spike/b';

export const scratch = message();
