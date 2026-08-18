// Etapp 1 kör EN fast tenant (KRAV-4). Raden seedas i migration 0001 och id:t
// är därför en konstant i koden i stället för konfiguration — det finns inget
// val att göra förrän multi-tenant byggs (Etapp 3), och en env-variabel hade
// bara varit ett sätt att peka fel.
export const TENANT_ID = '00000000-0000-0000-0000-000000000001';
