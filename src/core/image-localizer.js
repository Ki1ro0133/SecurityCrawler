const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ensureDir } = require('./storage');

function sha1(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex');
}

function inferImageExt(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const match = parsed.pathname.toLowerCase().match(/\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:$|\?)/);
    if (match) return `.${match[1] === 'jpg' ? 'jpg' : match[1]}`;
  } catch (_) {}
  return '.jpg';
}

function downloadWithReferer(urlStr, destPath, referer, redirectCount = 0) {
  const maxRedirects = 5;

  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': referer,
    };

    const req = client.get(urlStr, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectCount >= maxRedirects) {
          res.resume();
          reject(new Error('Too many redirects'));
          return;
        }

        const nextUrl = new URL(res.headers.location, urlStr).href;
        res.resume();
        downloadWithReferer(nextUrl, destPath, referer, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', (error) => {
        fs.unlink(destPath, () => reject(error));
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timeout')));
  });
}

async function localizeImagesInOutput({ outputDir, concurrency = 3, emit, referer }) {
  const papersDir = path.join(outputDir, 'papers');
  const imagesDir = path.join(papersDir, 'images');

  if (!fs.existsSync(papersDir)) {
    ensureDir(papersDir);
    emit('image_localize_ready', { created: true });
    return { scanned: 0, downloaded: 0 };
  }

  ensureDir(imagesDir);

  const markdownFiles = fs.readdirSync(papersDir).filter((fileName) => fileName.toLowerCase().endsWith('.md'));
  if (markdownFiles.length === 0) {
    emit('image_localize_ready', { created: false, totalFiles: 0 });
    emit('image_localize_complete', { scanned: 0, downloaded: 0 });
    return { scanned: 0, downloaded: 0 };
  }

  emit('image_localize_start', { totalFiles: markdownFiles.length });

  let totalImages = 0;
  let downloaded = 0;

  for (const mdName of markdownFiles) {
    const mdPath = path.join(papersDir, mdName);
    const raw = fs.readFileSync(mdPath, 'utf8').replace(/!\[[^\]]*\]\(data:image\/svg\+xml;[^)]+\)/gi, '');
    const remoteTasks = [];
    const dataTasks = [];

    let match;
    const imageRegex = /!\[[^\]]*\]\((https?:[^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((match = imageRegex.exec(raw)) !== null) {
      totalImages++;
      const url = match[1];
      const hashed = sha1(url).slice(0, 32);
      const ext = inferImageExt(url);
      const fileName = `${hashed}${ext}`;
      remoteTasks.push({
        full: match[0],
        url,
        localPath: path.join(imagesDir, fileName),
        localRel: `images/${fileName}`,
        ok: false,
      });
    }

    const dataRegex = /!\[[^\]]*\]\((data:image\/[a-zA-Z0-9.+-]+(?:;charset=[^;,)]+)?(?:;base64)?,[^)]+)(?:\s+"[^"]*")?\)/g;
    while ((match = dataRegex.exec(raw)) !== null) {
      totalImages++;
      const dataUrl = match[1];
      const mimeMatch = /^data:([^;,]+)(?:;charset=[^;,]+)?(?:;base64)?,/i.exec(dataUrl);
      const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg';
      let ext = '.jpg';

      if (mime.includes('png')) ext = '.png';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg';
      else if (mime.includes('gif')) ext = '.gif';
      else if (mime.includes('webp')) ext = '.webp';
      else if (mime.includes('bmp')) ext = '.bmp';
      else if (mime.includes('svg')) ext = '.svg';
      else if (mime.includes('ico')) ext = '.ico';

      const hashed = sha1(dataUrl).slice(0, 32);
      const fileName = `${hashed}${ext}`;
      dataTasks.push({
        full: match[0],
        dataUrl,
        localPath: path.join(imagesDir, fileName),
        localRel: `images/${fileName}`,
        ok: false,
      });
    }

    let taskIndex = 0;
    const poolSize = Math.max(1, Number(concurrency) || 1);
    const worker = async () => {
      while (taskIndex < remoteTasks.length) {
        const current = remoteTasks[taskIndex++];
        try {
          if (!fs.existsSync(current.localPath)) {
            await downloadWithReferer(current.url, current.localPath, referer);
            downloaded++;
          }
          current.ok = true;
        } catch (error) {
          current.ok = false;
        }
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    for (const task of dataTasks) {
      try {
        if (!fs.existsSync(task.localPath)) {
          const commaIndex = task.dataUrl.indexOf(',');
          const header = task.dataUrl.slice(0, commaIndex);
          const payload = task.dataUrl.slice(commaIndex + 1);
          const buffer = /;base64/i.test(header)
            ? Buffer.from(payload, 'base64')
            : Buffer.from(decodeURIComponent(payload), 'utf8');

          fs.writeFileSync(task.localPath, buffer);
          downloaded++;
        }
        task.ok = true;
      } catch (_) {
        task.ok = false;
      }
    }

    const replacements = [];
    for (const task of remoteTasks) {
      if (task.ok) replacements.push({ full: task.full, repl: task.full.replace(task.url, task.localRel) });
    }
    for (const task of dataTasks) {
      if (task.ok) replacements.push({ full: task.full, repl: task.full.replace(task.dataUrl, task.localRel) });
    }

    if (replacements.length) {
      let updated = raw;
      for (const replacement of replacements) {
        updated = updated.split(replacement.full).join(replacement.repl);
      }
      fs.writeFileSync(mdPath, updated, 'utf8');
      emit('image_localized', { fileName: mdName, replacements: replacements.length });
    }
  }

  emit('image_localize_complete', { scanned: totalImages, downloaded });
  return { scanned: totalImages, downloaded };
}

module.exports = {
  inferImageExt,
  localizeImagesInOutput,
  sha1,
};
