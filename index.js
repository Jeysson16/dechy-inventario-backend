const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'dechy-inventario-backend' });
});

// Endpoint to receive billing request and send to SUNAT
app.post('/api/sunat/emitir', async (req, res) => {
  try {
    const data = req.body;
    // TODO: Implement UBL 2.1 generation, digital signature using CDT and SOAP request to SUNAT.
    // In a real scenario, this involves heavy XML manipulation and crypto signing.
    
    // Mock response for now
    res.json({ 
      success: true, 
      message: 'Comprobante recibido (MOCK)', 
      data: {
        cdr: 'Aceptado',
        pdfUrl: 'mock-pdf-url'
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
