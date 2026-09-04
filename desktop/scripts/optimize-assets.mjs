import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const SOURCE_DIR = path.resolve('../../camio-app/camio-assests');
const ICONS_DIR = path.resolve('./assets/icons');
const WIZARD_DIR = path.resolve('./assets/wizard');
const BANNER_DIR = path.resolve('./assets');

// Ensure dirs exist
[ICONS_DIR, WIZARD_DIR, BANNER_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function main() {
    console.log('Optimizing App-icon.png...');
    const iconPath = path.join(SOURCE_DIR, 'App-icon.png');
    // App icons sizes for macOS (.icns) and Linux
    const macSizes = [16, 32, 64, 128, 256, 512, 1024];
    const iconsetDir = path.join(ICONS_DIR, 'icon.iconset');
    if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir);
    
    for (const size of macSizes) {
        // macOS iconset naming convention
        await sharp(iconPath).resize(size, size).png({ quality: 80, compressionLevel: 9 }).toFile(path.join(iconsetDir, `icon_${size}x${size}.png`));
        if (size <= 512) {
            await sharp(iconPath).resize(size * 2, size * 2).png({ quality: 80, compressionLevel: 9 }).toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`));
        }
    }
    // Convert to .icns using macOS built-in tool
    try {
        execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(ICONS_DIR, 'icon.icns')}"`);
        console.log('Created icon.icns');
    } catch (e) {
        console.log('iconutil failed, skipping .icns generation (maybe not on mac?)');
    }
    // Also save simple pngs for linux
    await sharp(iconPath).resize(512, 512).png({ quality: 80, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'icon-512x512.png'));
    await sharp(iconPath).resize(256, 256).png({ quality: 80, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'icon-256x256.png'));

    console.log('Optimizing system-tray.png...');
    const trayPath = path.join(SOURCE_DIR, 'system-tray.png');
    await sharp(trayPath).resize(22, 22).png({ quality: 90, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'tray-22x22.png'));
    await sharp(trayPath).resize(44, 44).png({ quality: 90, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'tray-22x22@2x.png'));
    await sharp(trayPath).resize(24, 24).png({ quality: 90, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'tray-24x24.png'));
    await sharp(trayPath).resize(48, 48).png({ quality: 90, compressionLevel: 9 }).toFile(path.join(ICONS_DIR, 'tray-48x48.png'));

    console.log('Optimizing banner.png...');
    const bannerPath = path.join(SOURCE_DIR, 'banner.png');
    await sharp(bannerPath).resize(1280, 640).png({ quality: 80, compressionLevel: 9 }).toFile(path.join(BANNER_DIR, 'banner-social.png'));
    await sharp(bannerPath).resize(1920, 960).webp({ quality: 80 }).toFile(path.join(BANNER_DIR, 'banner.webp'));

    console.log('Optimizing wizard images...');
    const wizards = ['welcome', 'choose-your-camera', 'set-password', 'success'];
    for (const w of wizards) {
        await sharp(path.join(SOURCE_DIR, `${w}.png`))
            .resize(900, 550)
            .webp({ quality: 80 })
            .toFile(path.join(WIZARD_DIR, `${w}.webp`));
    }
    
    console.log('Done!');
}

main().catch(console.error);
