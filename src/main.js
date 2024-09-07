const { screen, app, Menu, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { exec } = require('child_process');
const fs = require("fs");
const fse = require('fs-extra');
const os = require('os');
const path = require("path");
const glob = require('glob');
const WinReg = require('winreg');
const moment = require('moment');
const i18next = require("i18next");
const Backend = require("i18next-fs-backend");
const sqlite3 = require('sqlite3');
const GameData = require('./GameData');

app.commandLine.appendSwitch("lang", "en");

let win;
let settingsWin;

let settings;
let gameData = new GameData();
let writeQueue = Promise.resolve();

// Main window
const createWindow = async () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const dimensions = primaryDisplay.size;

    win = new BrowserWindow({
        width: dimensions.width * 0.4,
        height: dimensions.height * 0.5,
        icon: path.join(__dirname, "../assets/logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
        },
    });

    // win.webContents.openDevTools();
    win.loadURL(path.join(__dirname, "index.html"));

    win.on("closed", () => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window !== win) {
                window.close();
            }
        });

        if (process.platform !== "darwin") {
            app.quit();
        }
    });
};

app.whenReady().then(async () => {
    settings = loadSettings();
    await initializeI18next(settings['language']);
    await gameData.initialize();

    if (settings['gameInstalls'] === 'uninitialized') {
        await gameData.detectGamePaths();
        saveSettings('gameInstalls', gameData.detectedGamePaths);
    }

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Language settings
const initializeI18next = (language) => {
    return i18next
        .use(Backend)
        .init({
            lng: language,
            fallbackLng: "en_US",
            backend: {
                loadPath: path.join(__dirname, "../locale/{{lng}}.json"),
            },
        });
};

ipcMain.handle("translate", async (event, key, options) => {
    return i18next.t(key, options);
});

// Menu settings
const menuTemplate = [
    {
        label: "Options",
        submenu: [
            {
                label: "Settings",
                click() {
                    let settings_window_size = [650, 700];
                    // Check if settingsWin is already open
                    if (!settingsWin || settingsWin.isDestroyed()) {
                        settingsWin = new BrowserWindow({
                            width: settings_window_size[0],
                            height: settings_window_size[1],
                            minWidth: settings_window_size[0],
                            minHeight: settings_window_size[1],
                            icon: path.join(__dirname, "../assets/setting.ico"),
                            parent: win,
                            modal: true,
                            webPreferences: {
                                preload: path.join(__dirname, "preload.js"),
                            },
                        });

                        // settingsWin.webContents.openDevTools();
                        settingsWin.setMenuBarVisibility(false);
                        settingsWin.loadFile(path.join(__dirname, "components/settings.html"));

                        settingsWin.on("closed", () => {
                            settingsWin = null;
                        });
                    } else {
                        settingsWin.focus();
                    }
                },
            },
        ],
    },
];
const menu = Menu.buildFromTemplate(menuTemplate);
Menu.setApplicationMenu(menu);

// ======================================================================
// Settings
// ======================================================================
const loadSettings = () => {
    const userDataPath = app.getPath("userData");
    const appDataPath = app.getPath("appData");
    const settingsPath = path.join(userDataPath, "GSM Settings", "settings.json");

    const locale_mapping = {
        'en-US': 'en_US',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hant-HK': 'zh_CN',
        'zh-Hant-MO': 'zh_CN',
        'zh-Hant-TW': 'zh_CN',
    };

    const systemLocale = app.getLocale();
    // console.log(app.getPreferredSystemLanguages());
    const detectedLanguage = locale_mapping[systemLocale] || 'en_US';

    // Default settings
    const defaultSettings = {
        theme: 'dark',
        language: detectedLanguage,
        backupPath: path.join(appDataPath, "GSM Backups"),
        maxBackups: 5,
        gameInstalls: 'uninitialized',
        pinnedGames: []
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(data);

        // Merge with default settings to fill any missing keys
        return { ...defaultSettings, ...settings };
    } catch (err) {
        console.error("Error loading settings, using defaults:", err);
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
        return defaultSettings;
    }
};

function saveSettings(key, value) {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');

    settings[key] = value;

    // Queue the write operation to prevent simultaneous writes
    writeQueue = writeQueue.then(() => {
        return new Promise((resolve, reject) => {
            fs.writeFile(settingsPath, JSON.stringify(settings), (writeErr) => {
                if (writeErr) {
                    console.error('Error saving settings:', writeErr);
                    reject(writeErr);
                } else {
                    console.log(`Settings updated successfully: ${key}: ${value}`);

                    if (key === 'theme') {
                        BrowserWindow.getAllWindows().forEach((window) => {
                            window.webContents.send('apply-theme', value);
                        });
                    }

                    if (key === 'language') {
                        i18next.changeLanguage(value).then(() => {
                            BrowserWindow.getAllWindows().forEach((window) => {
                                window.webContents.send('apply-language');
                            });
                            resolve();
                        }).catch(reject);
                    } else {
                        resolve();
                    }
                }
            });
        });
    }).catch((err) => {
        console.error('Error in write queue:', err);
    });
}

// ======================================================================
// Listeners
// ======================================================================
ipcMain.on('save-settings', async (event, key, value) => {
    saveSettings(key, value);
});

ipcMain.on("load-theme", (event) => {
    event.reply("apply-theme", settings['theme']);
});

ipcMain.handle("get-settings", (event) => {
    return settings;
});

ipcMain.handle("get-detected-game-paths", async (event) => {
    await gameData.detectGamePaths();
    return gameData.detectedGamePaths;
});

ipcMain.handle('open-url', async (event, url) => {
    await shell.openExternal(url);
});

ipcMain.handle('open-backup-folder', async (event, wikiId) => {
    const backupPath = path.join(settings['backupPath'], wikiId.toString());
    if (fs.existsSync(backupPath) && fs.readdirSync(backupPath).length > 0) {
        await shell.openPath(backupPath);
    } else {
        win.webContents.send('show-alert', 'warning', i18next.t('main.no_backups_found'));
    }
});

ipcMain.handle('open-backup-dialog', async (event) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
        title: i18next.t('settings.select_backup_path'),
        properties: ['openDirectory'],
        modal: true
    });

    if (result.filePaths.length > 0) {
        return path.join(result.filePaths[0], 'GSM Backups');
    }

    return null;
});

ipcMain.handle('open-dialog', async (event) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
        title: i18next.t('settings.select_path'),
        properties: ['openDirectory'],
        modal: true
    });

    return result;
});

ipcMain.on('update-backup-table-main', (event) => {
    win.webContents.send('update-backup-table');
});

// ======================================================================
// Backup
// ======================================================================
// A sample processed game: {
//     title: 'Worms W.M.D',
//     wiki_page_id: 35700,
//     install_folder: 'WormsWMD',
//     steam_id: 327030,
//     gog_id: 1448620034,
//     save_location: {
//         win: [
//             '{{p|localappdata}}\\Packages\\Team17DigitalLimited.WormsW.M.DWin10_j5x4vj4y67jhc\\LocalCache\\Local\\Microsoft\\WritablePackageRoot\\CommonData',
//             '{{P|steam}}\\userdata\\{{P|uid}}\\327030',
//             '{{P|game}}\\CommonData\\local.cfg',
//             '{{p|public}}\\Public Documents\\Team17\\WormsWMD'
//         ],
//         reg: [],
//         mac: [],
//         linux: []
//     },
//     platform: [ 'Steam', 'Xbox', 'EA', 'GOG' ],
//     zh_CN: null,
//     install_path: 'F:\\SteamLibrary\\steamapps\\common\\WormsWMD',
//     latest_backup: '2024/9/1 21:00',
//     resolved_paths: [
//         {
//             template: '{{P|steam}}\\userdata\\{{P|uid}}\\327030',
//             resolved: 'D:\\Program Files\\Steam\\userdata\\477235894\\327030',
//             uid: '477235894'
//         },
//         {
//             template: '{{P|game}}\\CommonData\\local.cfg',
//             resolved: 'F:\\SteamLibrary\\steamapps\\common\\WormsWMD\\CommonData\\local.cfg',
//             uid: undefined
//         }
//     ],
//     backup_size: 414799
// }

ipcMain.handle('fetch-game-saves', async (event) => {
    try {
        const games = await getGameDataFromDB();
        return games;
    } catch (err) {
        win.webContents.send('show-alert', 'error', i18next.t('main.fetch_game_failed'));
        console.error("Failed to fetch game data:", err);
        return [];
    }
});

function getGameDataFromDB() {
    return new Promise((resolve, reject) => {
        const dbPath = path.join(__dirname, '../database/database.db');
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
        const gameInstallPaths = settings['gameInstalls'];

        const games = [];

        db.serialize(() => {
            const stmt = db.prepare("SELECT * FROM games WHERE install_folder = ?");

            gameInstallPaths.forEach(installPath => {
                const directories = fs.readdirSync(installPath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);

                directories.forEach(dir => {
                    stmt.get(dir, async (err, row) => {
                        if (err) {
                            console.error(`Error querying ${dir}:`, err);
                        } else if (row) {
                            row.platform = JSON.parse(row.platform);
                            row.save_location = JSON.parse(row.save_location);
                            row.install_path = path.join(installPath, dir);
                            row.latest_backup = getLatestBackup(row.wiki_page_id);
                            const processed_game = await process_game(row);
                            if (processed_game.resolved_paths.length != 0) {
                                games.push(processed_game);
                            }
                        }
                    });
                });
            });

            stmt.finalize(() => {
                db.close();
                resolve(games);
            });
        });
    });
}

function getLatestBackup(wiki_page_id) {
    const backupDir = path.join(settings['backupPath'], wiki_page_id.toString());

    if (!fs.existsSync(backupDir)) {
        return i18next.t('main.no_backups');
    }

    const backups = fs.readdirSync(backupDir).filter(file => {
        const fullPath = path.join(backupDir, file);
        return fs.statSync(fullPath).isDirectory();
    });

    if (backups.length === 0) {
        return i18next.t('main.no_backups');
    }

    const latestBackup = backups.sort((a, b) => {
        return b.localeCompare(a);
    })[0];

    return moment(latestBackup, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');
}

async function process_game(db_game_row) {
    const resolved_paths = [];
    let totalBackupSize = 0;

    const currentOS = os.platform();
    const osKeyMap = {
        win32: 'win',
        darwin: 'mac',
        linux: 'linux'
    };

    const osKey = osKeyMap[currentOS];

    if (osKey && db_game_row.save_location[osKey]) {
        for (const templatedPath of db_game_row.save_location[osKey]) {
            const resolvedPath = await resolveTemplatedPath(templatedPath, db_game_row.install_path);

            // Check whether the resolved path actually exists then calculate size
            if (resolvedPath.path.includes('*')) {
                const files = glob.sync(resolvedPath.path.replace(/\\/g, '/'));
                for (const filePath of files) {
                    if (fs.existsSync(filePath)) {
                        totalBackupSize += calculateDirectorySize(filePath);
                        resolved_paths.push({
                            template: templatedPath,
                            resolved: path.normalize(filePath),
                            uid: resolvedPath.uid
                        });
                    }
                }
            } else {
                if (fs.existsSync(resolvedPath.path)) {
                    totalBackupSize += calculateDirectorySize(resolvedPath.path);
                    resolved_paths.push({
                        template: templatedPath,
                        resolved: path.normalize(resolvedPath.path),
                        uid: resolvedPath.uid
                    });
                }
            }
        }
    }

    // Process registry paths
    if (osKey === 'win' && db_game_row.save_location['reg'] && db_game_row.save_location['reg'].length > 0) {
        for (const templatedPath of db_game_row.save_location['reg']) {
            const resolvedPath = await resolveTemplatedPath(templatedPath, null);

            const normalizedRegPath = path.normalize(resolvedPath.path);
            const { hive, key } = parseRegistryPath(normalizedRegPath);
            const winRegHive = getWinRegHive(hive);
            if (!winRegHive) {
                continue;
            }

            const registryKey = new WinReg({
                hive: winRegHive,
                key: key
            });

            await new Promise((resolve, reject) => {
                registryKey.keyExists((err, exists) => {
                    if (err) {
                        win.webContents.send('show-alert', 'error', `${i18next.t('main.registry_existence_check_failed')}: ${db_game_row.title}`);
                        console.error(`Error checking registry existence for ${db_game_row.title}: ${err}`);
                        return reject(err);
                    }
                    if (exists) {
                        resolved_paths.push({
                            template: templatedPath,
                            resolved: normalizedRegPath,
                            uid: resolvedPath.uid,
                            type: 'reg'
                        });
                    }
                    resolve();
                });
            });
        }
    }

    db_game_row.resolved_paths = resolved_paths;
    db_game_row.backup_size = totalBackupSize;

    return db_game_row;
}

function getWinRegHive(hive) {
    switch (hive) {
        case 'HKEY_CURRENT_USER': return WinReg.HKCU;
        case 'HKEY_LOCAL_MACHINE': return WinReg.HKLM;
        case 'HKEY_CLASSES_ROOT': return WinReg.HKCR;
        default: {
            console.warn(`Invalid registry hive: ${hive}`);
            return null;
        }
    }
}

function parseRegistryPath(registryPath) {
    const parts = registryPath.split('\\');
    const hive = parts.shift();
    const key = '\\' + parts.join('\\');

    return { hive, key };
}

// Resolves the templated path to the actual path based on the save_path_mapping
async function resolveTemplatedPath(templatedPath, gameInstallPath) {
    let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, match => {
        const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');

        if (normalizedMatch === '{{p|game}}') {
            return gameInstallPath;
        } else if (normalizedMatch === '{{p|steam}}') {
            return gameData.steamPath;
        } else if (normalizedMatch === '{{p|uplay}}' || normalizedMatch === '{{p|ubisoftconnect}}') {
            return gameData.ubisoftPath;
        } else if (normalizedMatch === '{{p|uid}}') {
            // Defer handling of {{p|uid}} to the next step
            return '{{p|uid}}';
        }

        return save_path_mapping[normalizedMatch] || match;
    });

    // Final check for unresolved placeholders, but ignore {{p|uid}}
    if (/\{\{p\|[^\}]+\}\}/i.test(basePath.toLowerCase().replace(/\{\{p\|uid\}\}/gi, ''))) {
        console.warn(`Unresolved placeholder found in path: ${basePath}`);
        return { path: '' };
    }

    // Handle {{p|uid}}
    if (basePath.includes('{{p|uid}}')) {
        return await fillPathUid(basePath);
    } else {
        return { path: basePath };
    }
}

async function fillPathUid(basePath) {
    const userIds = [gameData.currentSteamUserId64, gameData.currentSteamUserId3, gameData.currentUbisoftUserId];

    // Check with pre-determined user ids
    for (const uid of userIds) {
        const resolvedPath = basePath.replace(/\{\{p\|uid\}\}/gi, uid);
        const matchedPaths = glob.sync(resolvedPath.replace(/\\/g, '/'));

        if (matchedPaths.length > 0) {
            return {
                path: resolvedPath,
                uid: uid,
            };
        }
    }

    // If no valid paths found with userIds, attempt wildcard for uid
    const wildcardPath = basePath.replace(/\{\{p\|uid\}\}/gi, '*');
    const wildcardResolvedPaths = glob.sync(wildcardPath.replace(/\\/g, '/'));

    if (wildcardResolvedPaths.length === 0) {
        return { path: '' };
    }

    const latestPath = await findLatestModifiedPath(wildcardResolvedPaths);
    const extractedUid = extractUidFromPath(basePath, latestPath);
    return {
        path: basePath.replace(/\{\{p\|uid\}\}/gi, extractedUid),
        uid: extractedUid,
    };
}

// Find the latest modified path
async function findLatestModifiedPath(paths) {
    let latestPath = null;
    let latestTime = 0;

    for (const filePath of paths) {
        const stats = await fs.promises.stat(filePath);
        if (stats.mtimeMs > latestTime) {
            latestTime = stats.mtimeMs;
            latestPath = filePath;
        }
    }

    return latestPath;
}

// Extract the uid from the resolved path based on the template path
function extractUidFromPath(templatePath, resolvedPath) {
    const templateParts = templatePath.split(path.sep);
    const resolvedParts = resolvedPath.split(path.sep);

    // Find where {{p|uid}} appears in the template and extract the corresponding part from the resolved path
    const uidIndex = templateParts.findIndex(part => part.includes('{{p|uid}}'));

    if (uidIndex !== -1 && resolvedParts[uidIndex]) {
        return resolvedParts[uidIndex];
    }

    return null;
}

// Calculates the total size of a directory or file
function calculateDirectorySize(directoryPath) {
    let totalSize = 0;

    if (fs.lstatSync(directoryPath).isDirectory()) {
        const files = fs.readdirSync(directoryPath);
        files.forEach(file => {
            const filePath = path.join(directoryPath, file);
            if (fs.lstatSync(filePath).isDirectory()) {
                totalSize += calculateDirectorySize(filePath);
            } else {
                totalSize += fs.lstatSync(filePath).size;
            }
        });
    } else {
        totalSize += fs.lstatSync(directoryPath).size;
    }

    return totalSize;
}

ipcMain.handle('get-icon-map', async (event) => {
    return {
        'Steam': fs.readFileSync(path.join(__dirname, '../assets/steam.svg'), 'utf-8'),
        'Ubisoft': fs.readFileSync(path.join(__dirname, '../assets/ubisoft.svg'), 'utf-8'),
        'EA': fs.readFileSync(path.join(__dirname, '../assets/ea.svg'), 'utf-8'),
        'Epic': fs.readFileSync(path.join(__dirname, '../assets/epic.svg'), 'utf-8'),
        'GOG': fs.readFileSync(path.join(__dirname, '../assets/gog.svg'), 'utf-8'),
        'Xbox': fs.readFileSync(path.join(__dirname, '../assets/xbox.svg'), 'utf-8'),
        'Blizzard': fs.readFileSync(path.join(__dirname, '../assets/battlenet.svg'), 'utf-8'),
    };
});

const save_path_mapping = {
    // Windows
    '{{p|username}}': os.userInfo().username,
    '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
    '{{p|userprofile/documents}}': path.join(process.env.USERPROFILE || os.homedir(), 'Documents'),
    '{{p|userprofile/appdata/locallow}}': path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'LocalLow'),
    '{{p|appdata}}': process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
    '{{p|localappdata}}': process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
    '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
    '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),

    // Registry
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
    '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',

    // Mac
    '{{p|osxhome}}': os.homedir(),

    // Linux
    '{{p|linuxhome}}': os.homedir(),
    '{{p|xdgdatahome}}': process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

ipcMain.handle('backup-game', async (event, gameData) => {
    const gameBackupPath = path.join(settings['backupPath'], gameData.wiki_page_id.toString());

    // Create a new backup instance folder based on the current date and time
    const backupInstanceFolder = moment().format('YYYY-MM-DD_HH-mm');
    const backupInstancePath = path.join(gameBackupPath, backupInstanceFolder);

    try {
        const backupConfig = [];

        // Iterate over resolved paths and copy files to the backup instance
        for (const [index, resolvedPathObj] of gameData.resolved_paths.entries()) {
            const resolvedPath = path.normalize(resolvedPathObj.resolved);
            const pathFolderName = `path${index + 1}`;
            const targetPath = path.join(backupInstancePath, pathFolderName);

            if (resolvedPathObj['type'] === 'reg') {
                // Registry backup logic using reg.exe
                await fse.ensureDir(targetPath);
                const registryFilePath = path.join(targetPath, 'registry_backup.reg');

                const regExportCommand = `reg export "${resolvedPath}" "${registryFilePath}" /y`;
                exec(regExportCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error exporting registry key: ${resolvedPath}`, error);
                        return;
                    }
                });

                backupConfig.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.template,
                    uid: resolvedPathObj.uid || null
                });

            } else {
                // File/directory backup logic
                await fse.ensureDir(targetPath);
                const stats = await fse.stat(resolvedPath);
                if (stats.isDirectory()) {
                    await fse.copy(resolvedPath, targetPath, { overwrite: true });
                } else {
                    const targetFilePath = path.join(targetPath, path.basename(resolvedPath));
                    await fse.copy(resolvedPath, targetFilePath, { overwrite: true });
                }

                backupConfig.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.template,
                    uid: resolvedPathObj.uid || null
                });
            }
        }

        const configFilePath = path.join(backupInstancePath, 'backup_info.json');
        await fse.writeJson(configFilePath, backupConfig, { spaces: 4 });

        const existingBackups = (await fse.readdir(gameBackupPath)).sort((a, b) => {
            return a.localeCompare(b);
        });

        // If there are more backups than allowed, delete the oldest ones
        const maxBackups = settings['maxBackups'];
        if (existingBackups.length > maxBackups) {
            const backupsToDelete = existingBackups.slice(0, existingBackups.length - maxBackups);
            for (const backup of backupsToDelete) {
                const backupToDeletePath = path.join(gameBackupPath, backup);
                await fse.remove(backupToDeletePath);
            }
        }

    } catch (error) {
        win.webContents.send('show-alert', 'error', `${i18next.t('main.backup_error_for_game')}: ${gameData.title}`);
        console.error(`Error during backup for game: ${gameData.title}`, error);
    }
});

// ======================================================================
// Restore
// ======================================================================
