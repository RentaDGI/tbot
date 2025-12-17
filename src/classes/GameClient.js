const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { humanDelay, sleep } = require('../utils/time');
const logger = require('../utils/logger');

const SESSION_PATH = path.resolve(__dirname, '../../session.json');
const BUILDING_KEYWORDS = {
    barracks: ['cuartel', 'cuarteles', 'barracks'],
    stable: ['establo', 'estable', 'stable'],
    workshop: ['taller', 'taller de asedio', 'workshop'],
    residence: ['residencia', 'palacio', 'residence', 'palace']
};
const BUILDING_GIDS = {
    barracks: [19],
    stable: [20],
    workshop: [21],
    residence: [25, 26]
};

class GameClient {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        this.fieldCache = null;
        this.lastScanTime = null;
        this.CACHE_DURATION = 30 * 60 * 1000;
    }

    async init() {
        logger.info('Iniciando navegador...');
        this.browser = await chromium.launch({
            headless: process.env.HEADLESS === 'true',
            args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--window-size=1366,768']
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'es-ES'
        };

        if (fs.existsSync(SESSION_PATH)) {
            logger.info('ðŸ“‚ Cargando sesiÃ³n guardada...');
            try {
                contextOptions.storageState = SESSION_PATH;
            } catch (e) {
                logger.warn('Archivo de sesiÃ³n corrupto.');
            }
        }

        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
    }

    async login() {
        const url = process.env.GAME_URL;
        logger.info('Navegando al juego...');
        
        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 3000, 5000);

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… SesiÃ³n vÃ¡lida. Login saltado.');
                this.isLoggedIn = true;
                return true;
            }

            logger.info('ðŸ”‘ Iniciando sesiÃ³n manual...');
            const userField = await this.page.$('input[name="name"], input[name="username"]');
            if (userField) {
                await userField.fill(process.env.GAME_USERNAME);
                await humanDelay(this.page, 300, 600);
                await this.page.fill('input[name="password"]', process.env.GAME_PASSWORD);
                await humanDelay(this.page, 500, 1000);
                
                const btn = await this.page.$('button[type="submit"], input[type="submit"]');
                if (btn) {
                    await btn.click();
                    logger.info('   Esperando carga tras login...');
                    await humanDelay(this.page, 5000, 7000);
                }
            }

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… Login exitoso. Guardando sesiÃ³n...');
                this.isLoggedIn = true;
                await this.context.storageState({ path: SESSION_PATH });
                return true;
            } else {
                throw new Error('Fallo al iniciar sesiÃ³n.');
            }
        } catch (error) {
            if (!this.page.isClosed()) await this.page.screenshot({ path: 'error-login.png' });
            throw error;
        }
    }

    async checkIfLoggedIn() {
        if (this.page.isClosed()) return false;
        return !!(await this.page.$('#stockBar, .villageList, #sidebarBoxVillagelist, a[href*="logout"], .playerName'));
    }

    async clickBuildingSlot(slotId) {
        if (this.page.isClosed()) return;
        await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slotId}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1500, 2500);
    }

        async findBuildingSlot(buildingType, explicitSlot) {
        if (explicitSlot) return explicitSlot;
        const keywords = (BUILDING_KEYWORDS[buildingType] || [buildingType]).filter(Boolean);
        const gids = BUILDING_GIDS[buildingType] || [];
        if (!keywords.length) return null;

        const tryReadSlotFromPage = async () => {
            try {
                await this.page.goto(`${process.env.GAME_URL}/dorf2.php`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 900, 1400);
            } catch (error) {
                logger.warn('No se pudo abrir dorf2 para localizar edificio: ' + error.message);
                return null;
            }

            return await this.page.evaluate(({ keywords, gids }) => {
                const normalize = (text) => (text || '')
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .trim();

                const targets = keywords.map(normalize);
                const gidTargets = gids.map(g => parseInt(g, 10));

                const extractSlotFromEl = (el) => {
                    if (!el) return null;
                    const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
                    const dataId = el.getAttribute('data-id') || el.getAttribute('data-slotid');
                    const match = href.match(/id=(\d+)/);
                    if (match) return parseInt(match[1], 10);
                    if (dataId && !isNaN(parseInt(dataId, 10))) return parseInt(dataId, 10);
                    return null;
                };

                const candidates = Array.from(document.querySelectorAll('area[href*="build.php?id="], a[href*="build.php?id="], [href*="build.php?id="], [data-slotid], [data-id]'));
                for (const el of candidates) {
                    const slotId = extractSlotFromEl(el);
                    if (!slotId) continue;

                    const label = normalize(el.getAttribute('title') || el.getAttribute('alt') || el.textContent || '');
                    const classText = normalize(el.className || '');
                    const href = el.getAttribute('href') || '';
                    const gidMatch = href.match(/gid=(\d+)/);
                    const gid = gidMatch ? parseInt(gidMatch[1], 10) : null;

                    const byKeyword = targets.some(key => label.includes(key));
                    const byGid = gid !== null && gidTargets.includes(gid);
                    const classGid = gidTargets.some(g => classText.includes(`g${g}`));

                    if (byKeyword || byGid || classGid) {
                        return slotId;
                    }
                }

                for (const gid of gidTargets) {
                    const el = document.querySelector(`.g${gid}, [class*="g${gid}"]`);
                    if (el) {
                        const slotId = extractSlotFromEl(el) ||
                            extractSlotFromEl(el.querySelector('a[href*="build.php?id="]'));
                        if (slotId) return slotId;
                    }
                }

                const labels = Array.from(document.querySelectorAll('.buildingSlot, .label'));
                for (const el of labels) {
                    const link = el.querySelector('a[href*="build.php?id="]');
                    const slotId = extractSlotFromEl(link);
                    if (!slotId) continue;
                    const label = normalize(el.textContent || link.getAttribute('title') || '');
                    if (targets.some(key => label.includes(key))) return slotId;
                }

                return null;
            }, { keywords, gids });
        };

        let slot = await tryReadSlotFromPage();
        if (slot) {
            logger.info(`Edificio "${buildingType}" localizado en slot ${slot}.`);
            return slot;
        }

        const fallbackSlots = {
            barracks: [19, 18, 17, 16],
            stable: [20, 21],
            workshop: [21, 22, 23],
            residence: [25, 26]
        };

        const candidates = fallbackSlots[buildingType] || [];
        for (const candidate of candidates) {
            try {
                await this.page.goto(`${process.env.GAME_URL}/build.php?id=${candidate}`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 600, 900);
                const matches = await this.page.evaluate(({ keywords }) => {
                    const normalize = (text) => (text || '')
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .trim();
                    const titleEl = document.querySelector('.titleInHeader, h1');
                    const text = titleEl ? normalize(titleEl.textContent) : '';
                    return keywords.some(key => text.includes(normalize(key)));
                }, { keywords });
                if (matches) {
                    logger.info(`Edificio "${buildingType}" encontrado por fallback en slot ${candidate}.`);
                    return candidate;
                }
            } catch (error) {
                logger.warn(`No se pudo probar slot ${candidate}: ${error.message}`);
            }
        }

        logger.warn(`No se pudo localizar edificio "${buildingType}". Keywords: ${keywords.join(', ')}; gids: ${gids.join(', ')}`);
        return null;
    }

/**
     * ESCANER 1-A-1 BLINDADO ("Todo o Nada")
     */
    async scanSlotsOneByOne(maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            logger.info(`Escaneando campos uno a uno... (intento ${attempt}/${maxRetries})`);
            const fields = [];

            for (let slot = 1; slot <= 18; slot++) {
                try {
                    if (this.page.isClosed()) break;

                    await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                    await this.page.waitForTimeout(300);

                    const info = await this.getBuildingInfo();
                    const isUnderConstruction = await this.page.evaluate((currentSlot) => {
                        const queueBox = document.querySelector('.buildingList, .boxes-contents');
                        if (!queueBox) return false;
                        const links = queueBox.querySelectorAll('a');
                        for (const link of links) {
                            const href = link.getAttribute('href') || '';
                            if (href.includes(`id=${currentSlot}`)) {
                                const match = href.match(/id=(\d+)/);
                                if (match && parseInt(match[1]) === currentSlot) return true;
                            }
                        }
                        return false;
                    }, slot);

                    if (info.name) {
                        const name = info.name.toLowerCase();
                        let type = null;
                        if (name.includes('le\u00f1a') || name.includes('wood') || name.includes('bosque')) type = 'wood';
                        else if (name.includes('barr') || name.includes('clay') || name.includes('arcilla')) type = 'clay';
                        else if (name.includes('hierro') || name.includes('iron') || name.includes('mina')) type = 'iron';
                        else if (name.includes('granja') || name.includes('crop') || name.includes('cereal')) type = 'crop';

                        if (type) {
                            const effectiveLevel = isUnderConstruction ? info.level + 1 : info.level;
                            fields.push({ slot, type, level: effectiveLevel });
                            if (process.env.DEBUG === 'true') {
                                const status = isUnderConstruction ? '(build_queue)' : '';
                                console.log(`   Slot ${slot}: ${type} ${info.level} ${status}`);
                            }
                        }
                    }
                } catch (e) {
                    logger.warn(`Error leyendo slot ${slot}, reintentando...`);
                }
            }

            if (fields.length === 18) {
                this.fieldCache = fields;
                this.lastScanTime = Date.now();
                this.logCacheStatus();
                return fields;
            }

            logger.error(`ALERTA: Escaner incompleto (${fields.length}/18).`);
            if (attempt < maxRetries) {
                logger.warn('Reintentando escaneo completo en 3s...');
                await sleep(3000);
            } else {
                throw new Error('SCAN_INCOMPLETE_RETRY');
            }
        }
    }
    async scanFieldsIfNeeded(forceRescan = false) {
        const cacheValid = this.fieldCache && this.lastScanTime && (Date.now() - this.lastScanTime < this.CACHE_DURATION);
        if (cacheValid && !forceRescan) {
            logger.info('Usando cache de campos (vÃ¡lida)');
            return this.fieldCache;
        }
        return await this.scanSlotsOneByOne();
    }

    updateFieldLevel(slot, incrementLevel = true) {
        if (!this.fieldCache) return;
        for (const field of this.fieldCache) {
            if (field.slot === slot) {
                if (incrementLevel) field.level += 1;
                field.isBuilding = true;
                logger.info(`Cache actualizada: Slot ${slot} -> Nivel ${field.level}`);
                break;
            }
        }
    }

    findLowestFieldAcrossAllTasks(tasks, resourceAmounts = {}) {
        if (!this.fieldCache) return null;
        const resourceTasks = tasks.filter(task => task.building_type);
        if (!resourceTasks.length) return null;

        const allCandidates = [];

        for (const task of resourceTasks) {
            for (const field of this.fieldCache) {
                if (field.type === task.building_type &&
                    field.level < task.target_level &&
                    !field.isBuilding) {
                    const resourceValue = typeof resourceAmounts[field.type] === 'number'
                        ? resourceAmounts[field.type]
                        : Number.MAX_SAFE_INTEGER;
                    allCandidates.push({
                        slot: field.slot,
                        type: field.type,
                        level: field.level,
                        task,
                        targetLevel: task.target_level,
                        resourceValue
                    });
                }
            }
        }

        if (!allCandidates.length) return null;

        allCandidates.sort((a, b) => {
            if (a.level !== b.level) return a.level - b.level;
            return a.resourceValue - b.resourceValue;
        });

        const winner = allCandidates[0];
        logger.info(`Campo mÃ¡s bajo: ${winner.task.building_name} Slot ${winner.slot} (Nivel ${winner.level})`);
        return winner;
    }

    getCompletedResourceTasks(tasks) {
        if (!this.fieldCache) return [];
        return tasks.filter(task => {
            if (!task.building_type) return false;
            const fieldsOfType = this.fieldCache.filter(field => field.type === task.building_type);
            if (!fieldsOfType.length) return false;
            return fieldsOfType.every(field => field.level >= task.target_level);
        });
    }

    invalidateCache() {
        this.fieldCache = null;
        this.lastScanTime = null;
        logger.info('Cache de campos invalidada.');
    }

    logCacheStatus() {
        if (!this.fieldCache || !this.fieldCache.length) return;
        const summary = {};
        for (const field of this.fieldCache) {
            if (!summary[field.type]) {
                summary[field.type] = { count: 0, levels: [], building: 0 };
            }
            summary[field.type].count += 1;
            summary[field.type].levels.push(field.level);
            if (field.isBuilding) summary[field.type].building += 1;
        }
        logger.info('Estado de campos:');
        for (const type of Object.keys(summary)) {
            const data = summary[type];
            const minLevel = Math.min(...data.levels);
            const maxLevel = Math.max(...data.levels);
            logger.info(`   ${type}: ${data.count} campos, niveles ${minLevel}-${maxLevel}${data.building ? ` (${data.building} en cola)` : ''}`);
        }
    }

    async findLowestLevelField(buildingType, maxLevel) {
        // Usamos SIEMPRE el escÃ¡ner lento.
        const fields = await this.scanSlotsOneByOne();
        
        // VerificaciÃ³n extra de seguridad
        const typeCount = fields.filter(f => f.type === buildingType).length;
        if (typeCount === 0) {
            throw new Error(`SCAN_FAILED: No se encontraron campos de tipo ${buildingType}`);
        }

        const eligible = fields.filter(f => f.type === buildingType && f.level < maxLevel)
                               .sort((a, b) => a.level - b.level);
        
        return eligible.length > 0 ? eligible[0] : null;
    }

    async checkAndStartAdventure() {
        if (this.page.isClosed()) return false;
        logger.info('ðŸ—ºï¸ Revisando aventuras...');

        try {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 2000, 3000);

            const health = await this.getHeroHealthPercent({ skipNavigation: true });
            logger.info(`Salud del heroe: ${health}%. No se bloquea por salud.`);

            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button.green, .adventureList button'));
                for (const btn of buttons) {
                    const text = (btn.innerText || btn.value || '').toLowerCase().trim();
                    if (text.includes('explorar') || text.includes('comenzar') || text.includes('start')) {
                        if (btn.disabled || btn.classList.contains('disabled')) return { found: true, canClick: false };
                        btn.click();
                        return { found: true, canClick: true };
                    }
                }
                return { found: false };
            });

            if (result.canClick) {
                logger.success('âš”ï¸ Â¡HÃ©roe enviado!');
                await humanDelay(this.page, 2000, 3000);
                return true;
            } else {
                logger.info('Sin aventuras disponibles.');
            }
        } catch (error) {
            logger.warn('Error en aventuras:', error.message);
        }
        return false;
    }

    async checkAndRaidOases(oasisTargets, options = {}) {
        logger.info('Envio de heroe a oasis desactivado.');
        return false;
    }

    async getHeroHealthPercent(options = {}) {
        if (this.page.isClosed()) return 0;
        if (!options.skipNavigation) {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1500, 2500);
        }

        return await this.page.evaluate(() => {
            function extractNumber(text) {
                if (!text) return null;
                const percentMatch = text.match(/(\d{1,3})\s*%/);
                if (percentMatch) return parseInt(percentMatch[1], 10);
                const numberMatch = text.match(/(\d{1,3})/);
                return numberMatch ? parseInt(numberMatch[1], 10) : null;
            }

            const bar = document.querySelector('.heroHealthBar .bar');
            if (bar) {
                const width = bar.style.width || bar.getAttribute('style') || '';
                const match = width.match(/(\d{1,3})/);
                if (match) return Math.min(100, Math.max(0, parseInt(match[1], 10)));
            }

            const heroSection = document.querySelector('.heroHealthBar, .heroStats, .heroAttributes');
            const heroText = heroSection ? heroSection.innerText : '';
            const parsedFromText = extractNumber(heroText);
            if (parsedFromText !== null) return Math.min(100, Math.max(0, parsedFromText));

            const valueNode = document.querySelector('.heroHealthBar .value');
            return extractNumber(valueNode ? valueNode.innerText : '') || 0;
        });
    }

    async inspectOasisNatureTroops(oasis) {
        if (this.page.isClosed()) return null;

        await this.page.goto(`${process.env.GAME_URL}/karte.php?x=${oasis.x}&y=${oasis.y}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2200);

        return await this.page.evaluate(() => {
            const normalize = (txt) => (txt || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const animalWords = [
                'rata', 'ratas', 'rat', 'rats',
                'arana', 'aranas', 'spider', 'spiders',
                'serpiente', 'serpientes', 'snake', 'snakes',
                'murcielago', 'murcielagos', 'bat', 'bats',
                'jabali', 'jabalies', 'boar', 'boars',
                'lobo', 'lobos', 'wolf', 'wolves',
                'oso', 'osos', 'bear', 'bears',
                'cocodrilo', 'cocodrilos', 'crocodile', 'crocodiles',
                'tigre', 'tigres', 'tiger', 'tigers',
                'elefante', 'elefantes', 'elephant', 'elephants'
            ];

            const sumMatches = (source) => {
                let total = 0;
                let found = false;
                for (const word of animalWords) {
                    const regex = new RegExp(`(\\d+)\\s+${word}`, 'g');
                    let m;
                    while ((m = regex.exec(source)) !== null) {
                        total += parseInt(m[1], 10);
                        found = true;
                    }
                }
                return found ? total : null;
            };

            // 1) Intentar sumar desde bloques cercanos a "Tropas"
            const bodyText = normalize(document.body ? document.body.innerText : '');
            if (bodyText) {
                const nearTropas = bodyText.split('tropas').slice(1).join('tropas').slice(0, 400);
                const parsedNear = sumMatches(nearTropas);
                if (parsedNear !== null) return parsedNear;

                const parsedBody = sumMatches(bodyText);
                if (parsedBody !== null) return parsedBody;
            }

            // 2) Buscar listas de tropas en DOM (clases habituales)
            const containers = Array.from(document.querySelectorAll('.troops, .troop, .troopWrapper, .troopList, .troopInfo, .unit, .units, .unitWrapper'));
            for (const node of containers) {
                const text = normalize(node.innerText);
                if (!text) continue;
                const parsed = sumMatches(text);
                if (parsed !== null) return parsed;
            }

            // 3) Fallback clásico
            const patterns = [
                /tropas de la naturaleza[^\d]*(\d+)/i,
                /nature troops[^\d]*(\d+)/i,
                /naturtruppen[^\d]*(\d+)/i
            ];
            for (const pattern of patterns) {
                const match = bodyText.match(pattern);
                if (match) return parseInt(match[1], 10);
            }

            return null;
        });
    }

    async sendHeroFromCurrentOasis() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const result = await this.page.evaluate(() => {
            const findHeroInput = () => {
                const selectors = ['input[name*="hero"]', 'input[id*="hero"]'];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) return el;
                }
                const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
                for (const input of inputs) {
                    const descriptor = (input.name || input.id || input.placeholder || '').toLowerCase();
                    if (descriptor.includes('heroe') || descriptor.includes('hero')) {
                        return input;
                    }
                }
                return null;
            };

            const heroInput = findHeroInput();
            if (!heroInput) return { success: false, reason: 'hero_input_not_found' };
            if (heroInput.disabled) return { success: false, reason: 'hero_input_disabled' };

            heroInput.value = 1;
            heroInput.dispatchEvent(new Event('input', { bubbles: true }));
            heroInput.dispatchEvent(new Event('change', { bubbles: true }));

            const form = heroInput.closest('form') || heroInput.form;
            if (!form) return { success: false, reason: 'form_not_found' };

            const otherInputs = form.querySelectorAll('input[type="text"], input[type="number"]');
            for (const input of otherInputs) {
                if (input === heroInput) continue;
                input.value = 0;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
            const candidate = buttons.find(btn => {
                if (btn.disabled) return false;
                const label = (btn.innerText || btn.value || '').toLowerCase();
                return label.includes('atacar') || label.includes('enviar') || label.includes('attack') || label.includes('send');
            }) || buttons[0];

            if (!candidate) return { success: false, reason: 'submit_button_not_found' };
            if (candidate.disabled) return { success: false, reason: 'submit_button_disabled' };
            candidate.click();
            return { success: true };
        });

        if (result.success) {
            await humanDelay(this.page, 1500, 2200);
        }

        return result;
    }

    async getResourceAmounts() {
        if (this.page.isClosed()) return null;

        try {
            await this.page.goto(`${process.env.GAME_URL}/dorf1.php`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1000, 1600);
        } catch (error) {
            logger.warn('No se pudo visitar Dorf1 para leer recursos: ' + error.message);
            return null;
        }

        return await this.page.evaluate(() => {
            function parseAmount(raw) {
                if (!raw) return null;
                const cleaned = raw.replace(/[\\.\\,\\s]/g, '').replace(/[^0-9]/g, '');
                return cleaned ? parseInt(cleaned, 10) : null;
            }

            const stockBar = document.querySelector('#stockBar');
            const fallbackText = stockBar ? stockBar.innerText : document.body.innerText;
            const variants = {
                wood: ['madera', 'wood', 'holz'],
                clay: ['barro', 'clay', 'lehm', 'arcilla'],
                iron: ['hierro', 'iron', 'eisen', 'mineral'],
                crop: ['cereal', 'crop', 'trigo', 'gran']
            };

            const resources = {};
            for (const type in variants) {
                for (const label of variants[type]) {
                    const regex = new RegExp(label + '[^\\d]*(\\d[\\d\\.\\,]*)\\s*', 'i');
                    const match = fallbackText.match(regex);
                    if (match) {
                        const amount = parseAmount(match[1]);
                        if (amount !== null) {
                            resources[type] = amount;
                            break;
                        }
                    }
                }
            }

            return Object.keys(resources).length ? resources : null;
        });
    }

    async upgradeBuild() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };
        
        logger.info('Buscando botÃ³n de mejora...');
        const result = await this.page.evaluate(() => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const upgradeKeywords = ['mejora', 'mejorar', 'upgrade', 'construir', 'ampliar', 'nivel', 'level', 'build'];
            const blacklist = ['prolong', 'proteger', 'protecc', 'protection', 'plus', 'premium', 'activar', 'comprar', 'confirmar', 'cancelar', 'aventura', 'mision', 'adventure', 'prorrogar'];

            const collect = (root) => Array.from(root.querySelectorAll('button, input[type=\"submit\"], a.button'));
            const scopes = [
                document.querySelector('.buildAction'),
                document.querySelector('#contract'),
                document.querySelector('.upgradeButtons'),
                document.querySelector('.buildWrapper'),
                document.querySelector('.buildingDetails'),
                document
            ].filter(Boolean);

            const seen = new Set();
            const candidates = [];
            for (const scope of scopes) {
                for (const el of collect(scope)) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    candidates.push(el);
                }
            }

            for (const btn of candidates) {
                const text = normalize(btn.innerText || btn.value || '');
                const classes = normalize(btn.className || '');

                if (btn.disabled || classes.includes('disabled')) continue;
                if (classes.includes('gold')) continue;
                if (blacklist.some(word => text.includes(word))) continue;
                if (text.includes('npc') || text.includes('intercambiar')) continue;
                // Evitar diálogos de protección/plus
                if (text.includes('prolong') || text.includes('proteger') || text.includes('protecc')) continue;

                const isUpgradeKeyword = upgradeKeywords.some(k => text.includes(k));
                const isUpgradeClass = ['build', 'upgrade', 'contract'].some(k => classes.includes(k));
                if (!isUpgradeKeyword && !isUpgradeClass) continue;

                btn.click();
                return { success: true };
            }
            if (document.querySelector('.queueFull, .buildingQueueFull')) return { success: false, reason: 'queue_full' };
            return { success: false, reason: 'not_enough_resources' };
        });

        if (result.success) {
            await humanDelay(this.page, 2000, 3000);
            return { success: true };
        }
        return { success: false, reason: result.reason };
    }

    async executeTraining(buildingType, troopIdentifier, quantity = -1, buildingSlot = null) {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const slot = await this.findBuildingSlot(buildingType, buildingSlot);
        if (!slot) return { success: false, reason: 'building_not_found' };

        try {
            await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1200, 2000);
        } catch (error) {
            logger.warn('No se pudo abrir la pagina de entrenamiento: ' + error.message);
            return { success: false, reason: 'navigation_failed' };
        }

        const result = await this.page.evaluate(({ identifier, quantity }) => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const identifierIsNumber = typeof identifier === 'number' || (typeof identifier === 'string' && /^\d+$/.test(identifier));
            const targetIndex = identifierIsNumber ? parseInt(identifier, 10) : null;
            const targetName = identifierIsNumber ? null : normalize(identifier);

            const allInputs = Array.from(document.querySelectorAll('input[name^="t"], input[name*="t"], input[data-unitid], input[data-unit], input[type="number"]'));
            const rows = allInputs.map(input => input.closest('tr') || input.closest('.unit') || input.closest('.trainUnits') || input.closest('.textList') || input.closest('.unitWrapper') || input.parentElement).filter(Boolean);

            const pickQuantity = (row, input) => {
                if (quantity !== -1) return quantity;

                const maxAttr = input.getAttribute('max');
                if (maxAttr && !isNaN(parseInt(maxAttr, 10))) return parseInt(maxAttr, 10);

                const maxNode = row.querySelector('.max, a.max');
                if (maxNode) {
                    const match = maxNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                const valueNode = row.querySelector('.value, .maxValue');
                if (valueNode) {
                    const match = valueNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                return 0;
            };

            const seen = new Set();
            for (const row of rows) {
                if (seen.has(row)) continue;
                seen.add(row);

                const input = row.querySelector('input[name^="t"], input[name*="t"], input[data-unitid], input[data-unit], input[type="number"]');
                if (!input) continue;

                const inputName = input.getAttribute('name') || '';
                const dataUnit = input.getAttribute('data-unitid') || input.getAttribute('data-unit') || null;
                const indexMatch = inputName.match(/t(\d+)/);
                const troopIndex = indexMatch ? parseInt(indexMatch[1], 10) : (dataUnit ? parseInt(dataUnit, 10) : null);

                const rowText = normalize(row.innerText);
                const imgAlt = normalize((row.querySelector('img') || {}).alt || '');
                const candidateText = `${rowText} ${imgAlt}`.trim();

                const matches = targetIndex !== null
                    ? troopIndex === targetIndex
                    : candidateText.includes(targetName);

                if (!matches) continue;

                const qty = pickQuantity(row, input);
                if (!qty || qty <= 0) {
                    return { success: false, reason: 'not_enough_resources_or_zero_max' };
                }

                if (typeof input.scrollIntoView === 'function') {
                    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                input.value = qty;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                const form = input.closest('form') || document.querySelector('form[action*="train"]');
                if (!form) return { success: false, reason: 'form_not_found' };

                const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                const btn = buttons.find(b => {
                    if (b.disabled) return false;
                    const label = normalize(b.innerText || b.value || '');
                    if (label.includes('formacion') || label.includes('formar') || label.includes('formation')) return true;
                    return label.includes('entrenar') || label.includes('train') || label.includes('reclutar') || label.includes('enviar');
                }) || buttons.find(b => !b.disabled);

                if (!btn) return { success: false, reason: 'submit_button_not_found' };
                if (typeof btn.scrollIntoView === 'function') {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                btn.click();
                const isSubmitBtn = (btn.tagName === 'BUTTON' && (btn.getAttribute('type') || '').toLowerCase() === 'submit') ||
                    (btn.tagName === 'INPUT' && (btn.getAttribute('type') || '').toLowerCase() === 'submit');
                if (typeof form.requestSubmit === 'function') {
                    if (isSubmitBtn) form.requestSubmit(btn);
                    else form.requestSubmit();
                } else if (typeof form.submit === 'function') {
                    form.submit();
                }
                return { success: true, trained: qty };
            }

            return { success: false, reason: 'troop_not_found' };
        }, { identifier: troopIdentifier, quantity });

        if (!result.success) return result;

        await humanDelay(this.page, 2000, 3200);

        // Recargar la página para leer la cola actualizada
        try {
            await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 900, 1400);
        } catch (navErr) {
            logger.warn('No se pudo recargar pagina de entrenamiento para verificar cola: ' + navErr.message);
        }

        const verify = await this.page.evaluate(({ identifier }) => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const targetName = typeof identifier === 'string'
                ? normalize(identifier)
                : null;

            const errorEl = document.querySelector('.error, .alert, .warning, .messageError');
            if (errorEl) {
                return { ok: false, reason: 'page_error', message: normalize(errorEl.innerText) };
            }

            const queueSelectors = [
                '.under_progress', '.under-progress', '.trainingQueue', '.productionQueue',
                '.queue', '.underConstruction', '.build_queue', '.buildingList .under_progress',
                '.boxes-contents .under_progress', '.boxes-contents .under-progress',
                '.productionWrapper .under_progress', '.productionWrapper .under-progress',
                '#trainQueue', '.trainingList', '.queueWrapper', '.unitQueue'
            ];

            const queueEntries = Array.from(document.querySelectorAll(queueSelectors.join(',')))
                // Evitar el formulario principal de entrenamiento (contiene inputs numéricos)
                .filter(node => !node.querySelector('input[type=\"number\"], input[name^=\"t\"], input[name*=\"t\"]'));

            const matchesEntry = (node) => {
                const text = normalize(node.innerText || '');
                const hasTimer = /\d{1,2}:\d{2}/.test(text) || text.includes('curso') || text.includes('cola') || text.includes('queue');

                // Revisar imágenes con alt/title
                const imgs = Array.from(node.querySelectorAll('img'));
                const imgMatch = targetName && imgs.some(img => {
                    const alt = normalize(img.getAttribute('alt') || '');
                    const title = normalize(img.getAttribute('title') || '');
                    return alt.includes(targetName) || title.includes(targetName);
                });

                if (targetName) {
                    if (hasTimer && text.includes(targetName)) return true;
                    if (hasTimer && imgMatch) return true;
                } else if (hasTimer && /\d+\s*x/.test(text)) {
                    return true;
                }

                return false;
            };

            if (queueEntries.some(matchesEntry)) return { ok: true };

            // Fallback: buscar timers y nombre de tropa en bloques con temporizador
            const timers = Array.from(document.querySelectorAll('.timer, .dur, .countdown'));
            for (const timer of timers) {
                const container = timer.closest('li, tr, .textList, .buildDetails, .details, .queue, .under_progress, .under-progress') || timer.parentElement;
                const text = normalize((container && container.innerText) || '');
                if (!text) continue;

                const imgs = container ? Array.from(container.querySelectorAll('img')) : [];
                const imgMatch = targetName && imgs.some(img => {
                    const alt = normalize(img.getAttribute('alt') || '');
                    const title = normalize(img.getAttribute('title') || '');
                    return alt.includes(targetName) || title.includes(targetName);
                });

                if (targetName) {
                    if (text.includes(targetName) || imgMatch) return { ok: true };
                } else if (/\d+\s*x/.test(text)) {
                    return { ok: true };
                }
            }

            const queueText = queueEntries.map(n => normalize(n.innerText || '')).filter(Boolean).slice(0, 5);

            return { ok: false, reason: 'training_not_queued', queueText };
        }, { identifier: troopIdentifier }).catch(() => null);

        if (!verify || !verify.ok) {
            try { await this.screenshot('training-fail.png'); } catch (e) {}
            return {
                success: false,
                reason: (verify && verify.reason) || 'training_not_queued',
                detail: (verify && verify.message) || null,
                queueText: (verify && verify.queueText) || null
            };
        }

        return result;
    }

    async getBuildingInfo() {
        if (this.page.isClosed()) return {};
        return await this.page.evaluate(() => {
            const titleEl = document.querySelector('.titleInHeader, h1');
            if (!titleEl) return {};
            const text = titleEl.textContent;
            const levelMatch = text.match(/(\d+)/);
            return {
                name: text.replace(/\d+/, '').trim(),
                level: levelMatch ? parseInt(levelMatch[0]) : 0
            };
        });
    }

    async screenshot(filename) {
        if (this.page && !this.page.isClosed()) await this.page.screenshot({ path: filename });
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

module.exports = GameClient;




