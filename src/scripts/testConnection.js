/**
 * Testea la conexión a Supabase
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function test() {
    console.log('🔍 Testeando conexión a Supabase...\n');

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY
    );

    // Test básico
    const { data, error } = await supabase.from('accounts').select('count');
    
    if (error) {
        console.error('❌ Error de conexión:', error.message);
        console.log('\n💡 Posibles soluciones:');
        console.log('   1. Verifica SUPABASE_URL y SUPABASE_KEY en .env');
        console.log('   2. Ejecuta schema.sql en Supabase SQL Editor');
        return;
    }

    console.log('✅ Conexión exitosa a Supabase\n');

    // Verificar cuenta
    const { data: account } = await supabase
        .from('accounts')
        .select('*')
        .eq('username', process.env.GAME_USERNAME)
        .single();

    if (account) {
        console.log('✅ Cuenta encontrada:', account.username);
    } else {
        console.log('⚠️  Cuenta no encontrada. Creándola...');
        
        await supabase.from('accounts').insert({
            username: process.env.GAME_USERNAME,
            server_url: process.env.GAME_URL
        });
        
        console.log('✅ Cuenta creada');
    }

    // Ver tareas pendientes
    const { data: tasks } = await supabase
        .from('build_queue')
        .select('*')
        .eq('status', 'pending');

    console.log(`\n📋 Tareas pendientes: ${tasks?.length || 0}`);
}

test();