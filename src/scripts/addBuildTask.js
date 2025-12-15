/**
 * Script para añadir tareas de construcción a la cola
 * Uso: node src/scripts/addBuildTask.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

async function addBuildTasks() {
    const { data: account } = await supabase
        .from('accounts')
        .select('id')
        .eq('username', process.env.GAME_USERNAME)
        .single();

    if (!account) {
        console.error('❌ Cuenta no encontrada');
        return;
    }

    // ========================================================
    // === DEFINE AQUÍ TUS TAREAS DE CONSTRUCCIÓN ===
    // ========================================================
    
    const tasks = [
        // CAMPOS DE RECURSOS (el bot elegirá el de menor nivel automáticamente)
        // building_type: 'wood' | 'clay' | 'iron' | 'crop'
        
        { building_type: 'wood', building_name: 'Leñador', target_level: 5, priority: 10 },
        { building_type: 'clay', building_name: 'Barrera', target_level: 5, priority: 10 },
        { building_type: 'iron', building_name: 'Mina de Hierro', target_level: 4, priority: 9 },
        { building_type: 'crop', building_name: 'Granja', target_level: 4, priority: 9 },
        
        // EDIFICIOS ESPECÍFICOS (usa building_slot)
        // Slots 19-40 son edificios del centro de aldea
        // { building_slot: 26, building_name: 'Edificio Principal', target_level: 3, priority: 8 },
        // { building_slot: 33, building_name: 'Almacén', target_level: 5, priority: 7 },
    ];

    // ========================================================

    // Limpiar tareas pendientes anteriores (opcional)
    const { error: deleteError } = await supabase
        .from('build_queue')
        .delete()
        .eq('account_id', account.id)
        .eq('status', 'pending');

    if (deleteError) {
        console.warn('⚠️ No se pudieron limpiar tareas anteriores');
    }

    // Insertar nuevas tareas
    const tasksWithAccount = tasks.map(task => ({
        ...task,
        account_id: account.id,
        status: 'pending'
    }));

    const { data, error } = await supabase
        .from('build_queue')
        .insert(tasksWithAccount)
        .select();

    if (error) {
        console.error('❌ Error:', error.message);
    } else {
        console.log(`\n✅ ${data.length} tareas añadidas:\n`);
        data.forEach(t => {
            const target = t.building_type ? `Tipo: ${t.building_type}` : `Slot: ${t.building_slot}`;
            console.log(`   📦 ${t.building_name} → Nivel ${t.target_level} (${target})`);
        });
        console.log('\n💡 Ejecuta: npm start');
    }
}

addBuildTasks();