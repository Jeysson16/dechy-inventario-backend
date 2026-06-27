const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Dechy Inventario Backend API is running. Para emitir comprobantes use /api/sunat/emitir.');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'dechy-inventario-backend' });
});

// Endpoint to receive billing request and send to SUNAT
app.post('/api/sunat/emitir', async (req, res) => {
  try {
    const { sale, documentType, customerDocument, amountPaid, paymentMethod } = req.body;
    
    // 1. Aquí se extrae la configuración de SUNAT (RUC, Usuario SOL, Clave SOL)
    // En un entorno real se obtendría de la BD (Firestore) o variables de entorno.
    const ruc = process.env.SUNAT_RUC;
    const userSol = process.env.SUNAT_USER_SOL;
    const passSol = process.env.SUNAT_PASS_SOL;

    // 2. Construcción del XML (UBL 2.1)
    // Este es un esquema simplificado. Se requiere mapear todos los items de la venta.
    const isFactura = documentType === 'Factura';
    const tipoDoc = isFactura ? '01' : '03'; // 01: Factura, 03: Boleta
    const serie = isFactura ? 'F001' : 'B001';
    const correlativo = sale.ticketNumber || Math.floor(Math.random() * 1000000);
    
    // El XML real es mucho más extenso (Invoice, cac:AccountingSupplierParty, etc.)
    let xmlString = \`<?xml version="1.0" encoding="ISO-8859-1" standalone="no"?>
    <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ccts="urn:un:unece:uncefact:documentation:2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:qdt="urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1" xmlns:udt="urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule:2">
      <ext:UBLExtensions>
        <ext:UBLExtension>
          <ext:ExtensionContent></ext:ExtensionContent>
        </ext:UBLExtension>
      </ext:UBLExtensions>
      <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
      <cbc:CustomizationID>2.0</cbc:CustomizationID>
      <cbc:ID>\${serie}-\${correlativo}</cbc:ID>
      <cbc:IssueDate>\${new Date().toISOString().split('T')[0]}</cbc:IssueDate>
      <cbc:InvoiceTypeCode listID="0101">\${tipoDoc}</cbc:InvoiceTypeCode>
      <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
      <cbc:LineCountNumeric>\${sale.items?.length || 1}</cbc:LineCountNumeric>
      <!-- Aquí irían los datos del emisor (Dechy), el cliente y los items -->
    </Invoice>\`;

    // 3. Firma del XML con xml-crypto usando el CDT (.pfx a .pem)
    // En un caso real se usa el certificado cargado.
    console.log("Firma digital del comprobante...");
    
    // 4. Envío por SOAP a SUNAT
    // const soapEnv = \`<soapenv:Envelope ...\`
    // const sunatRes = await axios.post('https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService', soapEnv, { headers });
    
    // 5. Lectura de la respuesta (CDR - Constancia de Recepción)
    console.log("Enviando comprobante a SUNAT...");

    // Mock response for now
    res.json({ 
      success: true, 
      message: 'Comprobante emitido correctamente', 
      data: {
        cdr: 'Aceptado por SUNAT (MOCK)',
        pdfUrl: \`https://dechy-inventario-backend.vercel.app/pdf/\${serie}-\${correlativo}.pdf\`
      } 
    });
  } catch (error) {
    console.error('Error emitting to SUNAT:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);
});
