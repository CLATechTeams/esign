const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ===== CONFIGURATION =====
// ĐỔI THÔNG TIN NÀY THÀNH GITHUB CỦA BẠN
const CONFIG = {
    repoOwner: 'clatechteams',        // 👈 Thay bằng username GitHub của bạn
    repoName: 'esign',        // 👈 Thay bằng tên repository
    branch: 'main',
    plistDir: path.join(__dirname, '../plists'),
    uploadDir: path.join(__dirname, '../uploads')
};

// ===== PARSE PLIST =====
function parsePlist(xml) {
    const result = {
        ipaUrl: null,
        appName: 'ESign',
        bundleId: 'com.esign.app',
        bundleVersion: '1.0.0',
        appSub: 'Unknown'
    };

    // Extract IPA URL
    const ipaMatch = xml.match(/<string>(https?:\/\/[^\s<]+\.ipa)<\/string>/);
    if (ipaMatch) {
        result.ipaUrl = ipaMatch[1];
    }

    // Try alternative IPA URL pattern
    if (!result.ipaUrl) {
        const urlMatch = xml.match(/<key>url<\/key>\s*<string>(https?:\/\/[^\s<]+)<\/string>/);
        if (urlMatch) {
            result.ipaUrl = urlMatch[1];
        }
    }

    // Extract app name/title
    const titleMatch = xml.match(/<key>title<\/key>\s*<string>([^<]+)<\/string>/);
    if (titleMatch) {
        result.appName = titleMatch[1];
    } else {
        // Try first string as title
        const firstString = xml.match(/<string>([^<]+)<\/string>/);
        if (firstString) {
            result.appName = firstString[1];
        }
    }

    // Extract bundle ID
    const bundleIdMatch = xml.match(/<key>bundle-identifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (bundleIdMatch) {
        result.bundleId = bundleIdMatch[1];
    }

    // Extract bundle version
    const versionMatch = xml.match(/<key>bundle-version<\/key>\s*<string>([^<]+)<\/string>/);
    if (versionMatch) {
        result.bundleVersion = versionMatch[1];
    }

    return result;
}

// ===== GENERATE PLIST =====
function generatePlistContent(plistData, ipaUrl) {
    // Giữ nguyên tất cả thông tin từ plist gốc
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${ipaUrl}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${plistData.bundleId}</string>
                <key>bundle-version</key>
                <string>${plistData.bundleVersion}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${plistData.appName}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;
}

// ===== DOWNLOAD FILE =====
async function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outputPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(outputPath);
            });
        }).on('error', (err) => {
            fs.unlink(outputPath, () => {});
            reject(err);
        });
    });
}

// ===== UPLOAD TO GITHUB =====
async function uploadToGitHub(filePath, remotePath, token, message) {
    const content = fs.readFileSync(filePath);
    const base64Content = Buffer.from(content).toString('base64');
    
    const url = `https://api.github.com/repos/${CONFIG.repoOwner}/${CONFIG.repoName}/contents/${remotePath}`;
    
    const data = {
        message: message || `Upload ${path.basename(filePath)}`,
        content: base64Content,
        branch: CONFIG.branch
    };
    
    // Try to get existing file SHA
    try {
        const getResponse = await fetch(url, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (getResponse.ok) {
            const existing = await getResponse.json();
            data.sha = existing.sha;
        }
    } catch (e) {
        // File doesn't exist, continue
    }
    
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify(data)
    });
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(`GitHub API error: ${error.message || response.status}`);
    }
    
    const result = await response.json();
    return result.content.download_url || `https://raw.githubusercontent.com/${CONFIG.repoOwner}/${CONFIG.repoName}/${CONFIG.branch}/${remotePath}`;
}

// ===== MAIN MIRROR FUNCTION =====
async function mirrorPlist(plistUrl, token) {
    console.log(`📥 Fetching plist from: ${plistUrl}`);
    console.log(`📂 Target repo: ${CONFIG.repoOwner}/${CONFIG.repoName}`);
    
    // Fetch plist
    const response = await fetch(plistUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch plist: HTTP ${response.status}`);
    }
    const plistContent = await response.text();
    
    // Parse plist
    console.log(`📋 Parsing plist...`);
    const plistData = parsePlist(plistContent);
    
    if (!plistData.ipaUrl) {
        throw new Error('No IPA URL found in plist');
    }
    
    console.log(`📱 App: ${plistData.appName}`);
    console.log(`📦 Bundle ID: ${plistData.bundleId}`);
    console.log(`📌 Version: ${plistData.bundleVersion}`);
    console.log(`🔗 IPA: ${plistData.ipaUrl}`);
    
    // Create directories
    fs.mkdirSync(CONFIG.uploadDir, { recursive: true });
    fs.mkdirSync(CONFIG.plistDir, { recursive: true });
    
    // Download IPA
    const ipaFileName = path.basename(plistData.ipaUrl);
    const ipaPath = path.join(CONFIG.uploadDir, ipaFileName);
    
    console.log(`📥 Downloading IPA...`);
    await downloadFile(plistData.ipaUrl, ipaPath);
    const stats = fs.statSync(ipaPath);
    console.log(`✅ Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Upload IPA to GitHub
    const plistId = path.basename(plistUrl).replace('.plist', '');
    const remoteIpaPath = `uploads/${plistId}/${ipaFileName}`;
    
    console.log(`📤 Uploading IPA to GitHub...`);
    const ipaUrl = await uploadToGitHub(
        ipaPath, 
        remoteIpaPath, 
        token,
        `Upload IPA for ${plistId}`
    );
    console.log(`✅ IPA uploaded: ${ipaUrl}`);
    
    // Generate and upload new plist
    console.log(`📝 Generating new plist...`);
    const newPlist = generatePlistContent(plistData, ipaUrl);
    const plistPath = path.join(CONFIG.plistDir, `${plistId}.plist`);
    fs.writeFileSync(plistPath, newPlist);
    
    const remotePlistPath = `plists/${plistId}.plist`;
    console.log(`📤 Uploading plist to GitHub...`);
    await uploadToGitHub(
        plistPath,
        remotePlistPath,
        token,
        `Update plist for ${plistId}`
    );
    
    // Generate result
    const plistUrlNew = `https://${CONFIG.repoOwner}.github.io/${CONFIG.repoName}/${remotePlistPath}`;
    const itmsLink = `itms-services://?action=download-manifest&url=${plistUrlNew}`;
    
    console.log(`\n✅ Mirror completed!`);
    console.log(`📱 App: ${plistData.appName}`);
    console.log(`📦 Bundle ID: ${plistData.bundleId}`);
    console.log(`📌 Version: ${plistData.bundleVersion}`);
    console.log(`🔗 New plist: ${plistUrlNew}`);
    console.log(`📱 Install link: ${itmsLink}`);
    
    return { 
        plistUrl: plistUrlNew, 
        itmsLink,
        appName: plistData.appName,
        bundleId: plistData.bundleId,
        bundleVersion: plistData.bundleVersion
    };
}

// ===== COMMAND LINE USAGE =====
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error(`
Usage: node mirror.js <plistUrl> <githubToken> [repoOwner] [repoName]

Example:
  node mirror.js https://example.com/app.plist ghp_xxxxx username repo-name

If repoOwner and repoName are not provided, uses values from CONFIG.
        `);
        process.exit(1);
    }
    
    const [plistUrl, token, customOwner, customRepo] = args;
    
    // Override config if provided
    if (customOwner) CONFIG.repoOwner = customOwner;
    if (customRepo) CONFIG.repoName = customRepo;
    
    mirrorPlist(plistUrl, token).catch(err => {
        console.error('❌ Error:', err.message);
        process.exit(1);
    });
}

module.exports = { mirrorPlist, parsePlist, generatePlistContent };
