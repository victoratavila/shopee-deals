import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * O `tsc` só compila arquivos .ts - ele ignora o HTML/CSS/JS do painel
 * administrativo. Sem esta cópia, `npm start` sobe a API mas o painel
 * retorna 404 em produção.
 */
const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const from = path.join(root, "src", "web", "public");
const to = path.join(root, "dist", "web", "public");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

console.log(`[build] arquivos do painel copiados para ${path.relative(root, to)}`);
