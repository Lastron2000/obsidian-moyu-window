// Obsidian 更新后重新打透明补丁。
// 用法：双击同目录的「重新打补丁.cmd」，或者 node 本文件。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian');

function findAsar() {
  let list = [];
  try {
    list = fs.readdirSync(DIR).filter((f) => /^obsidian-[\d.]+\.asar$/.test(f));
  } catch (e) {
    return null;
  }
  if (!list.length) return null;
  // 版本号排序取最大
  list.sort((a, b) => {
    const va = a.replace(/^obsidian-/, '').replace(/\.asar$/, '').split('.').map(Number);
    const vb = b.replace(/^obsidian-/, '').replace(/\.asar$/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const x = va[i] || 0, y = vb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  });
  return path.join(DIR, list[list.length - 1]);
}

function patch(src, out) {
  const buf = fs.readFileSync(src);
  const headerLen = buf.readUInt32LE(12);
  const d4 = buf.readUInt32LE(4) - headerLen;
  const d8 = buf.readUInt32LE(8) - headerLen;
  const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'));
  const dataStart = 16 + headerLen;

  const files = [];
  (function walk(node, prefix) {
    for (const k of Object.keys(node.files || {})) {
      const v = node.files[k];
      const p = prefix + '/' + k;
      if (v.files) walk(v, p);
      else files.push({ path: p, node: v, offset: Number(v.offset), size: v.size || 0, unpacked: !!v.unpacked });
    }
  })(header, '');
  files.sort((a, b) => a.offset - b.offset);

  for (const f of files) {
    f.data = f.unpacked ? null : buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size);
  }

  const target = files.find((f) => f.path === '/main.js');
  if (!target) return { ok: false, reason: '包内没有 /main.js' };

  const src2 = target.data.toString('utf8');
  if (src2.includes('backgroundMaterial:"none"')) return { ok: true, already: true };

  const needle = 'minWidth:200,minHeight:150,backgroundColor:"#00000000"';
  if (!src2.includes(needle)) return { ok: false, reason: '锚点没找到，版本结构可能变了' };

  const patched = src2.replace(
    needle,
    'minWidth:200,minHeight:150,transparent:!0,backgroundMaterial:"none",thickFrame:!1,backgroundColor:"#00000000"'
  );
  target.data = Buffer.from(patched, 'utf8');
  target.size = target.data.length;

  let off = 0;
  for (const f of files) {
    if (f.unpacked) continue;
    f.newOffset = off;
    off += f.data.length;
    f.node.offset = String(f.newOffset);
    f.node.size = f.data.length;
  }

  let headerStr = JSON.stringify(header);
  const mod = headerLen % 4;
  let guard = 0;
  while (Buffer.byteLength(headerStr, 'utf8') % 4 !== mod && guard < 8) { headerStr += ' '; guard++; }
  const newLen = Buffer.byteLength(headerStr, 'utf8');

  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(newLen + d4, 4);
  head.writeUInt32LE(newLen + d8, 8);
  head.writeUInt32LE(newLen, 12);

  const parts = [head, Buffer.from(headerStr, 'utf8')];
  for (const f of files) if (!f.unpacked) parts.push(f.data);
  fs.writeFileSync(out, Buffer.concat(parts));
  return { ok: true, files: files.length, grew: target.data.length - src2.length };
}

(function main() {
  const asar = findAsar();
  if (!asar) {
    console.log('没在 ' + DIR + ' 找到 obsidian-*.asar。');
    console.log('说明当前用的是安装目录里的版本，需要改 resources\\obsidian.asar。');
    process.exit(1);
  }
  console.log('目标:', asar);
  const bak = asar + '.bak';
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(asar, bak);
    console.log('已备份:', path.basename(bak));
  }
  const out = asar + '.new';
  const r = patch(asar, out);
  if (!r.ok) {
    console.log('失败:', r.reason);
    try { fs.unlinkSync(out); } catch (e) {}
    process.exit(1);
  }
  if (r.already) {
    console.log('已经打过补丁了，不用重打。');
    try { fs.unlinkSync(out); } catch (e) {}
    process.exit(0);
  }
  // 用备份做底，避免二次叠加
  const r2 = patch(bak, out);
  if (!r2.ok) {
    console.log('从备份重打失败:', r2.reason);
    process.exit(1);
  }
  fs.copyFileSync(out, asar);
  fs.unlinkSync(out);
  console.log('打好了，main.js +' + r2.grew + ' 字节，共 ' + r2.files + ' 个文件。');
  console.log('重新打开 Obsidian 就是透明的了。');
})();
