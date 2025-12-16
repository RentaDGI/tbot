const { createClient } = require('@supabase/supabase-js');
const GameClient = require('./GameClient');
const { sleep, isNightMode, randomInterval } = require('../utils/time');
const logger = require('../utils/logger');

const OASIS_RAID_TARGETS = [
    { x: -81, y: 71 },
    { x: -74, y: 65 },
    { x: -73, y: 65 },
    { x: -84, y: 73 },
    { x: -71, y: 70 },
    { x: -70, y: 70 }
];
const OASIS_RAID_INTERVAL_MS = 15 * 60 * 1000;

class TaskRunner {
    constructor() {
        this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.client = new GameClient();
        this.isRunning = false;
        this.account = null;
        this.cycleCount = 0;
        this.lastOasisRaid = 0;
    }

    async start() {
        try {
            await this.client.init();
            const { data: account } = await this.supabase
                .from('accounts')
                .select('*')
                .eq('username', process.env.GAME_USERNAME)
                .single();
            
            if (!account) throw new Error('Cuenta no encontrada en DB');
            this.account = account;
            logger.init(this.supabase, account.id);
            
            await this.client.login();
            
            logger.info('===========================================');
            logger.info('ESCANEO INICIAL DE CAMPOS...');
            await this.client.scanSlotsOneByOne();
            logger.info('===========================================');
            
            this.isRunning = true;
            logger.success('=== BOT INICIADO ===');
            await this.loop();
        } catch (error) {
            if (!this.isClosedError(error)) {
                logger.error('Error al iniciar', { error: error.message });
            }
        } finally {
            await this.shutdown();
        }
    }

    async loop() {
        while (this.isRunning) {
            try {
                this.cycleCount++;
                // Se desactiva el envío de héroe a oasis; solo aventuras.
                
                if (isNightMode()) {
                    logger.info('Modo nocturno. Esperando...');
                    await sleep(30 * 60 * 1000);
                    continue;
                }

                // Revisa aventuras en cada ciclo (sin filtrar por salud)
                await this.client.checkAndStartAdventure();

                if (this.cycleCount % 50 === 0) {
                    logger.info('Re-escaneo periodico...');
                    await this.client.scanSlotsOneByOne();
                }

                const buildTasks = await this.getPendingBuildTasks();
                const trainingTasks = await this.getPendingTrainingTasks();

                const totalTasks = buildTasks.length + trainingTasks.length;
                
                if (totalTasks === 0) {
                    await this.humanPause('Sin tareas pendientes', 90000, 160000);
                    continue;
                }

                logger.info('Tareas: ' + buildTasks.length + ' construccion, ' + trainingTasks.length + ' entrenamiento');

                let buildResult = { success: false, reason: 'no_tasks' };
                
                if (buildTasks.length > 0) {
                    const completedTasks = this.client.getCompletedResourceTasks(buildTasks);
                    for (const task of completedTasks) {
                        logger.success('Construccion completada: ' + task.building_name);
                        await this.completeBuildTask(task.id);
                    }

                    const remainingBuild = buildTasks.filter(function(t) {
                        return !completedTasks.find(function(ct) { return ct.id === t.id; });
                    });

                    if (remainingBuild.length > 0) {
                        const { sortedTasks, resourceAmounts } = await this.reorderResourceTasks(remainingBuild);
                        buildResult = await this.handleBuildWithCache(sortedTasks, resourceAmounts);
                    }
                }

                let trainingResult = { success: false, reason: 'no_tasks' };

                if (trainingTasks.length > 0) {
                    trainingTasks.sort(function(a, b) { return b.priority - a.priority; });
                    
                    for (const task of trainingTasks) {
                        trainingResult = await this.handleTrainingTask(task);
                        
                        if (trainingResult.success) {
                            break;
                        }
                        
                        if (trainingResult.reason === 'not_enough_resources') {
                            logger.info('Sin recursos para entrenar. Saltando...');
                            continue;
                        }
                        
                        if (trainingResult.reason === 'building_not_found') {
                            logger.warn('Edificio no encontrado: ' + task.building_type);
                            continue;
                        }
                    }
                }

                if (buildResult.success || trainingResult.success) {
                    await this.humanPause('Acción ejecutada', 9000, 15000);
                } else if (buildResult.reason === 'queue_full') {
                    await this.humanPause('Cola de construcción llena', 120000, 160000);
                } else if (buildResult.reason === 'not_enough_resources' &&
                           trainingResult.reason === 'not_enough_resources') {
                    await this.humanPause('Sin recursos suficientes', 150000, 230000);
                } else {
                    await this.humanPause('Revisando tareas en breve', 30000, 70000);
                }

            } catch (error) {
                if (this.isClosedError(error)) {
                    this.isRunning = false;
                    break;
                }
                
                if (error.message.includes('SCAN_INCOMPLETE')) {
                    logger.warn('Escaneo incompleto. Reintentando...');
                    this.client.invalidateCache();
                    await sleep(30000);
                    continue;
                }

                logger.error('Error en loop', { error: error.message });
                await sleep(10000);
            }
        }
    }

    async maybeRaidOases() {
        const now = Date.now();
        if (now - this.lastOasisRaid < OASIS_RAID_INTERVAL_MS) return;
        this.lastOasisRaid = now;

        logger.info('Revisando oasis objetivo para enviar héroe...');
        try {
            const sent = await this.client.checkAndRaidOases(OASIS_RAID_TARGETS);
            if (sent) {
                logger.success('Héroe despachado a uno de los oasis programados.');
            } else {
                logger.info('Ningún oasis necesitaba ataque en esta tanda.');
            }
        } catch (error) {
            logger.warn('Error en el chequeo de oasis: ' + error.message);
        }
    }

    async humanPause(reason, minMs, maxMs) {
        const delay = randomInterval(minMs, maxMs);
        logger.info(`${reason}. Esperando ${(delay / 1000).toFixed(1)}s...`);
        await sleep(delay);
    }

    async reorderResourceTasks(tasks) {
        if (!tasks || tasks.length === 0) return { sortedTasks: [], resourceAmounts: null };

        const resourceTasks = [];
        const otherTasks = [];

        for (const task of tasks) {
            if (task.building_type) resourceTasks.push(task);
            else otherTasks.push(task);
        }

        let resourceAmounts = null;
        try {
            resourceAmounts = await this.client.getResourceAmounts();
        } catch (error) {
            logger.warn('No se pudieron leer los recursos actuales: ' + error.message);
        }

        const resourceMap = resourceAmounts || {};

        resourceTasks.sort((a, b) => {
            const aVal = resourceMap[a.building_type] ?? Number.MAX_SAFE_INTEGER;
            const bVal = resourceMap[b.building_type] ?? Number.MAX_SAFE_INTEGER;
            if (aVal !== bVal) return aVal - bVal;
            return (b.priority || 0) - (a.priority || 0);
        });

        return { sortedTasks: [...resourceTasks, ...otherTasks], resourceAmounts: resourceMap };
    }

    async getPendingBuildTasks() {
        const { data } = await this.supabase
            .from('build_queue')
            .select('*')
            .eq('account_id', this.account.id)
            .eq('status', 'pending')
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true })
            .limit(20);
        
        return data || [];
    }

    async handleBuildWithCache(tasks, resourceAmounts = {}) {
        try {
            await this.client.scanFieldsIfNeeded();
            const nonResourceTasks = tasks.filter(t => !t.building_type);
            const lowestField = this.client.findLowestFieldAcrossAllTasks(tasks, resourceAmounts);

            const tryNonResource = async () => {
                if (!nonResourceTasks.length) return { success: false, reason: 'no_nonresource_tasks' };
                for (const nonResource of nonResourceTasks) {
                    try {
                        const targetSlot = nonResource.building_slot || null;
                        if (targetSlot) {
                            await this.client.clickBuildingSlot(targetSlot);
                        } else if (nonResource.building_name) {
                            const slot = await this.client.findBuildingSlot(nonResource.building_name);
                            if (slot) await this.client.clickBuildingSlot(slot);
                        }
                        const upgradeResult = await this.client.upgradeBuild();
                        if (upgradeResult.success) {
                            logger.success('Construccion (edificio): ' + (nonResource.building_name || nonResource.id || 'desconocido'));
                            if (nonResource.id) await this.completeBuildTask(nonResource.id);
                            return { success: true };
                        }
                        logger.info('No se pudo mejorar edificio (motivo: ' + upgradeResult.reason + ').');
                        // si falla por recursos o cola, sigue probando siguiente edificio
                        if (upgradeResult.reason !== 'not_enough_resources' && upgradeResult.reason !== 'queue_full') {
                            return { success: false, reason: upgradeResult.reason };
                        }
                    } catch (e) {
                        logger.warn('No se pudo ejecutar tarea de edificio: ' + e.message);
                        return { success: false, reason: 'building_task_failed' };
                    }
                }
                return { success: false, reason: 'nonresource_all_failed' };
            };

            if (!lowestField) {
                return await tryNonResource();
            }

            await this.client.clickBuildingSlot(lowestField.slot);
            const upgradeResult = await this.client.upgradeBuild();

            if (upgradeResult.success) {
                logger.success('Construccion: ' + lowestField.task.building_name + ' (Slot ' + lowestField.slot + ': ' + lowestField.level + ' -> ' + (lowestField.level + 1) + ')');
                this.client.updateFieldLevel(lowestField.slot, true);
                return { success: true };
            }

            // Loguea la razón y deja continuar con otras tareas
            logger.info('No se pudo mejorar recurso (motivo: ' + upgradeResult.reason + ').');
            if (upgradeResult.reason === 'not_enough_resources' || upgradeResult.reason === 'queue_full') {
                const fallback = await tryNonResource();
                if (fallback.success) return fallback;
            }
            return { success: false, reason: upgradeResult.reason };
        } catch (error) {
            if (this.isClosedError(error)) return { success: false, reason: 'browser_closed' };
            logger.error('Error en handleBuildWithCache', { error: error.message });
            return { success: false, reason: 'error' };
        }
    }

    async completeBuildTask(taskId) {
        await this.supabase
            .from('build_queue')
            .update({ status: 'completed', completed_at: new Date() })
            .eq('id', taskId);
    }

    async getPendingTrainingTasks() {
        const { data } = await this.supabase
            .from('training_queue')
            .select('*')
            .eq('account_id', this.account.id)
            .in('status', ['pending', 'in_progress'])
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true })
            .limit(10);
        
        return data || [];
    }

    async handleTrainingTask(task) {
        try {
            var troopName = task.troop_name || ('Tropa #' + task.troop_index);
            logger.info('Procesando entrenamiento: ' + troopName);

            if (task.repeat_forever && task.last_trained_at) {
                const lastTrained = new Date(task.last_trained_at);
                const minInterval = (task.repeat_interval || 0) * 60 * 1000;
                
                if (Date.now() - lastTrained.getTime() < minInterval) {
                    logger.info('Esperando intervalo de repeticion...');
                    return { success: false, reason: 'waiting_interval' };
                }
            }

            const troopIdentifier = task.troop_name || task.troop_index || 1;
            const totalTrained = task.trained_total || 0;
            let requestedQuantity = task.quantity ?? -1;
            const hasFixedQuantity = !task.repeat_forever && typeof task.quantity === 'number' && task.quantity !== -1;

            if (hasFixedQuantity) {
                const remaining = task.quantity - totalTrained;
                if (remaining <= 0) {
                    await this.supabase
                        .from('training_queue')
                        .update({
                            status: 'completed',
                            completed_at: new Date()
                        })
                        .eq('id', task.id);
                    logger.info('Tarea ya completada según total entrenado. Se marca como completada automáticamente.');
                    return { success: false, reason: 'already_completed' };
                }
                requestedQuantity = remaining;
            }

            const result = await this.client.executeTraining(
                task.building_type,
                troopIdentifier,
                requestedQuantity,
                task.building_slot
            );

            if (result.success) {
                logger.success('Entrenados: ' + result.trained + 'x ' + troopIdentifier);

                const newTotal = (task.trained_total || 0) + result.trained;

                if (task.repeat_forever) {
                    await this.supabase
                        .from('training_queue')
                        .update({ 
                            trained_total: newTotal,
                            last_trained_at: new Date(),
                            status: 'in_progress'
                        })
                        .eq('id', task.id);
                } else if (task.quantity === -1 || newTotal >= task.quantity) {
                    await this.supabase
                        .from('training_queue')
                        .update({ 
                            trained_total: newTotal,
                            status: 'completed',
                            completed_at: new Date()
                        })
                        .eq('id', task.id);
                    
                    logger.success('Tarea de entrenamiento completada!');
                } else {
                    await this.supabase
                        .from('training_queue')
                        .update({ 
                            trained_total: newTotal,
                            last_trained_at: new Date()
                        })
                        .eq('id', task.id);
                }

                return { success: true, trained: result.trained };
            }

            logger.warn('Entrenamiento no ejecutado', { reason: result.reason || 'unknown' });
            return result;

        } catch (error) {
            if (this.isClosedError(error)) {
                return { success: false, reason: 'browser_closed' };
            }
            logger.error('Error en handleTrainingTask', { error: error.message });
            return { success: false, reason: 'error' };
        }
    }

    isClosedError(error) {
        return error.message && (
            error.message.includes('Target page') || 
            error.message.includes('Session closed') || 
            error.message.includes('browser has been closed')
        );
    }

    async shutdown() {
        logger.info('Apagando bot...');
        await this.client.close();
    }
}

module.exports = TaskRunner;
