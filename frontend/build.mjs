import {createHash} from 'node:crypto';
import {readdir, readFile, writeFile, mkdir, copyFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function build(output = path.join(root, 'dist')) {
  output = path.resolve(output);
  const source = path.join(root, 'src');
  if (
    root === output ||
    root.startsWith(`${output}${path.sep}`) ||
    output === source ||
    output.startsWith(`${source}${path.sep}`)
  )
    throw new Error('Build output must be separate from the source tree');
  const directories = new Set();
  async function directory(relative = '') {
    if (directories.has(relative)) return;
    if (relative) await directory(path.dirname(relative) === '.' ? '' : path.dirname(relative));
    const target = path.join(output, relative);
    const info = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Build output contains a symlink: ${target}`);
    if (info && !info.isDirectory()) throw new Error(`Build output is not a directory: ${target}`);
    await mkdir(target, {recursive: true});
    directories.add(relative);
  }
  async function targetFile(relative) {
    await directory(path.dirname(relative) === '.' ? '' : path.dirname(relative));
    const target = path.join(output, relative);
    const info = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Build output contains a symlink: ${target}`);
    if (info && !info.isFile()) throw new Error(`Build output is not a regular file: ${target}`);
    return target;
  }
  await directory();
  const files = [];
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = path.posix.join(prefix, name);
      const info = await lstat(path.join(directory, name));
      if (info.isSymbolicLink()) throw new Error(`Source symlinks are not build inputs: ${relative}`);
      if (info.isDirectory()) await walk(path.join(directory, name), relative);
      else if (/\.(js|css)$/.test(name))
        files.push({name: relative, data: await readFile(path.join(directory, name))});
    }
  }
  await walk(path.join(root, 'src'));
  const names = new Set(files.map((file) => file.name));
  for (const file of files.filter((file) => file.name.endsWith('.js'))) {
    for (const match of file.data.toString().matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file.name), match[1]));
      if (!names.has(dependency)) throw new Error(`Missing module ${match[1]} imported by ${file.name}`);
    }
  }
  for (const required of ['app.js', 'styles.css', 'theme-init.js'])
    if (!names.has(required)) throw new Error(`Missing frontend entry: ${required}`);
  const template = await readFile(path.join(root, 'index.html'), 'utf8');
  const hash = createHash('sha256').update(template);
  for (const file of files) hash.update(file.name).update('\0').update(file.data).update('\0');
  const version = hash.digest('hex').slice(0, 24);
  for (const file of files) {
    const target = await targetFile(path.join('ui', version, file.name));
    await writeFile(target, file.data);
  }
  for (const name of ['logo.png', 'favicon.ico', 'apple-touch-icon.png'])
    await copyFile(path.join(root, '..', 'brand', name), await targetFile(path.join('brand', name)));
  await writeFile(await targetFile('index.html'), template.replaceAll('__RELEASE__', version), 'utf8');
  await writeFile(
    await targetFile('build.json'),
    JSON.stringify({version, assets: files.map((file) => `/ui/${version}/${file.name}`)}, null, 2) + '\n',
    'utf8'
  );
  return {version, files: files.length, output};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--out='));
  const result = await build(argument ? path.resolve(argument.slice(6)) : undefined);
  console.log(`Built ${result.files} assets → ${result.output} (${result.version})`);
}
