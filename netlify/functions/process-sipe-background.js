const { google } = require('googleapis');
const admin = require('firebase-admin');

// --- Inicialización (se ejecuta una sola vez por "cold start" de la función) ---

function getServiceAccount() {
  const json = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8');
  return JSON.parse(json);
}

if (!admin.apps.length) {
  const serviceAccount = getServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}
const db = admin.firestore();

// Algunas respuestas de la API vienen envueltas en un bloque de código markdown
// (```json ... ``` o ``` ... ```) a pesar de que el prompt pide que no lo haga.
function limpiarJson(texto) {
  let limpio = texto.trim();
  limpio = limpio.replace(/^```(?:json)?\s*/i, '');
  limpio = limpio.replace(/```\s*$/i, '');
  return limpio.trim();
}

// --- El prompt de extracción que armamos para SIPE (carnes) ---

const SIPE_PROMPT = `Sos un extractor de datos de facturas del proveedor SIPE (carnes).

Reglas específicas de este proveedor:
1. Los números usan formato estadounidense: coma de miles, punto decimal (ej. "1,234.56" = 1234.56).
2. La factura puede tener DOS fechas distintas: "Fecha de Emisión" y "Fecha de Vencimiento" (o similar). Usá SIEMPRE la Fecha de Emisión como "fecha" — nunca la de vencimiento.
3. El código de producto puede repetirse entre variantes distintas del mismo corte. Usá código + descripción juntos para identificar el ítem, nunca solo el código.
4. CRÍTICO — la tabla de ítems tiene DOS columnas de cantidad separadas: "Unidades" (cantidad de bultos/cajas/piezas) y "Kilos" (peso). Tenés que elegir CUÁL de las dos usar como cantidad_comprada según el valor de "Kilos":
   - Si "Kilos" es MAYOR A 0 para esa línea: el ítem se vende POR PESO. Usá el valor de la columna "Kilos" (no el de "Unidades") como cantidad_comprada. unidad_compra = "kg", contenido_por_unidad = 1, contenido_unidad_medida = "kg".
   - Si "Kilos" es 0 (o la columna no tiene valor) para esa línea: el ítem se vende POR UNIDAD/CAJA. Usá el valor de la columna "Unidades" como cantidad_comprada. unidad_compra = el tipo de empaque según la descripción (ej. "caja", "cajón") o "unidad" si no se especifica. contenido_por_unidad = 1, contenido_unidad_medida = "unidad".
   Ejemplo real: una línea con Unidades=1, Kilos=10.000, Precio Unitario=19909.50, Total=189140.27 → cantidad_comprada debe ser 10 (los kilos), NO 1 (las unidades). Si usás 1, la validación (cantidad × precio) no va a cerrar ni de cerca con el total.
   OJO: la DESCRIPCIÓN del producto a veces menciona un peso como parte del nombre del envase (ej. "CAJON DE POLLO FADEL X 20KG", "CAJA DE SUPREMA IQF X15KG") — eso es solo el tamaño del paquete, NO significa que la línea se venda por peso. Lo único que determina si una línea se vende por peso es si la columna "Kilos" de ESA línea tiene un valor mayor a 0. Si "Kilos" = 0 para esa línea, se vende por unidad/cajón aunque la descripción mencione "KG" en el nombre.
5. IMPORTANTE — descuento oculto: SIPE tiene un acuerdo comercial fijo de 5% de descuento sobre los ítems vendidos POR PESO (los de la regla 4 con columna "Kilos" > 0), pero ese 5% casi nunca aparece impreso como número en la columna de descuento de la factura — el total de la línea YA lo tiene aplicado. Para esos ítems, poné descuento_pct = 5 aunque la factura no lo muestre explícitamente, de forma que cantidad × precio_unitario × (1 - 5/100) coincida con el total impreso. Para los ítems vendidos por unidad/caja (columna "Kilos" = 0, aunque la descripción mencione un peso), descuento_pct = 0 salvo que la factura muestre explícitamente otro descuento en esa línea — NUNCA apliques el 5% solo porque la descripción menciona "KG".
6. Ignorá el descuento global de fin de factura (a veces aparece como "DESCUENTO: $..." o un "%5.00" suelto cerca del saldo) y cualquier "SALDO ANTERIOR" / "NUEVO SALDO" — son de la cuenta corriente del cliente, no de esta factura.
7. El PDF puede contener más de una factura concatenada. Devolvé una lista de facturas, no asumas que hay una sola.

Devolvé SOLO este JSON, sin texto adicional, sin markdown, sin backticks:
{
  "facturas": [
    {
      "proveedor": "SIPE",
      "razon_social": "",
      "comprobante_nro": "",
      "fecha": "YYYY-MM-DD",
      "total_factura": 0,
      "items": [ { "codigo": "", "descripcion": "", "cantidad_comprada": 0, "unidad_compra": "", "contenido_por_unidad": 0, "contenido_unidad_medida": "", "precio_unitario": 0, "descuento_pct": 0, "total": 0 } ]
    }
  ]
}`;

// --- Handler principal (BACKGROUND FUNCTION: el navegador recibe un 202 inmediato,
//     esto sigue corriendo por atrás hasta 15 minutos, sin depender de que el navegador espere) ---

exports.handler = async (event, context) => {
  const runId = `run_${Date.now()}`;
  const runRef = db.collection('runs').doc(runId);
  await runRef.set({
    proveedor: 'SIPE',
    estado: 'corriendo',
    inicio: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: getServiceAccount(),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // 1. Encontrar TODAS las carpetas llamadas "SIPE" (hay una por cada mes,
    //    dentro de FC Comprobantes > Nuevos > <Mes> > SIPE)
    const foldersRes = await drive.files.list({
      q: "name = 'SIPE' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 100,
    });

    if (!foldersRes.data.files.length) {
      await runRef.update({ estado: 'error', error: 'No se encontró ninguna carpeta llamada SIPE en Drive' });
      return;
    }

    // 2. Listar los PDFs dentro de CADA una de esas carpetas y juntarlos todos
    let files = [];
    for (const folder of foldersRes.data.files) {
      const filesRes = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType = 'application/pdf' and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        pageSize: 200,
      });
      files = files.concat(filesRes.data.files || []);
    }

    const MAX_POR_EJECUCION = 150; // subido temporalmente para procesar de una el atrasado histórico
    const resumen = { procesadas: 0, ya_existian: 0, pendientes_revision: 0, errores: 0, detalle: [] };

    for (const file of files) {
      if (resumen.procesadas >= MAX_POR_EJECUCION) break;

      // 3. Saltar si ya lo procesamos antes (idempotencia)
      const yaExiste = await db.collection('facturas_procesadas').doc(file.id).get();
      if (yaExiste.exists) {
        resumen.ya_existian++;
        continue;
      }

      try {
        console.log(`[${file.name}] empezando`);
        const t0 = Date.now();

        // 4. Descargar el PDF como binario
        const fileRes = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const base64Pdf = Buffer.from(fileRes.data).toString('base64');
        console.log(`[${file.name}] PDF descargado, t=${Date.now() - t0}ms`);

        // 5. Mandarlo a la API de Anthropic, como documento (no como texto)
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
                  { type: 'text', text: SIPE_PROMPT },
                ],
              },
            ],
          }),
        });

        console.log(`[${file.name}] respuesta de Anthropic recibida, t=${Date.now() - t0}ms`);
        const claudeData = await claudeRes.json();
        const textBlock = (claudeData.content || []).find((b) => b.type === 'text');

        if (!textBlock) {
          throw new Error('La API no devolvió texto: ' + JSON.stringify(claudeData));
        }

        let parsed;
        try {
          parsed = JSON.parse(limpiarJson(textBlock.text));
        } catch (e) {
          await db.collection('facturas_pendientes_revision').add({
            proveedor: 'SIPE',
            archivo: file.name,
            fileId: file.id,
            motivo: 'La respuesta de la API no era JSON válido',
            respuesta_cruda: textBlock.text,
            fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
          });
          resumen.pendientes_revision++;
          continue;
        }

        // 6. Validar cada línea y guardar
        let lineasValidas = 0;
        let lineasInvalidas = 0;

        for (const factura of parsed.facturas || []) {
          for (const item of factura.items || []) {
            const descuento = item.descuento_pct || 0;
            const calculado = item.cantidad_comprada * item.precio_unitario * (1 - descuento / 100);
            const diferencia = Math.abs(calculado - item.total);
            const valido = diferencia < 2; // tolerancia de redondeo

            const compra = {
              proveedor: 'SIPE',
              comprobante_nro: factura.comprobante_nro || null,
              fecha: factura.fecha || null,
              codigo: item.codigo || null,
              descripcion: item.descripcion,
              cantidad_comprada: item.cantidad_comprada,
              unidad_compra: item.unidad_compra,
              contenido_por_unidad: item.contenido_por_unidad,
              contenido_unidad_medida: item.contenido_unidad_medida,
              precio_unitario: item.precio_unitario,
              descuento_pct: descuento,
              total: item.total,
              fileId: file.id,
              archivo_origen: file.name,
              fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (valido) {
              await db.collection('compras').add(compra);
              lineasValidas++;
            } else {
              await db.collection('facturas_pendientes_revision').add({
                ...compra,
                motivo: `No cierra la validación: cantidad×precio×(1-desc%) = ${calculado.toFixed(2)}, pero el total dice ${item.total}`,
              });
              lineasInvalidas++;
            }
          }
        }

        // 7. Marcar el archivo como procesado (para no reprocesarlo la próxima vez)
        await db.collection('facturas_procesadas').doc(file.id).set({
          archivo: file.name,
          proveedor: 'SIPE',
          lineas_validas: lineasValidas,
          lineas_pendientes_revision: lineasInvalidas,
          fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
        });

        resumen.procesadas++;
        if (lineasInvalidas > 0) resumen.pendientes_revision += lineasInvalidas;
        resumen.detalle.push({ archivo: file.name, lineas_validas: lineasValidas, lineas_pendientes: lineasInvalidas });

        await runRef.update({ ...resumen, estado: 'corriendo' });
      } catch (err) {
        resumen.errores++;
        resumen.detalle.push({ archivo: file.name, error: err.message });
        await runRef.update({ ...resumen, estado: 'corriendo' });
      }
    }

    const restantes = files.length - resumen.procesadas - resumen.ya_existian;
    resumen.mensaje = restantes > 0
      ? `Procesadas ${resumen.procesadas}. Quedan ${restantes} facturas nuevas sin procesar — volvé a disparar la función para seguir.`
      : `Procesadas ${resumen.procesadas}. No quedan facturas nuevas.`;

    await runRef.update({ ...resumen, estado: 'terminado', fin: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('ERROR COMPLETO:', err);
    await runRef.update({
      estado: 'error',
      error: err.message,
      code: err.code || null,
      fin: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
};
