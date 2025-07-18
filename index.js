import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';

const app = express();
app.use(express.json());

// Conexão com o MySQL
const pool = mysql.createPool({
  host: 'localhost',      // ou 'mysql' se estiver rodando o Node dentro de container
  user: 'user',
  password: 'password',
  database: 'testdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Criação de tabela de exemplo
async function init() {
  const connection = await pool.getConnection();

  // Tabela de usuários/clientes
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      senha VARCHAR(255) NOT NULL,
      permissao ENUM('ADM', 'CLIENTE') DEFAULT 'CLIENTE',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_gasto DECIMAL(10,2) DEFAULT 0.00,
      cliente_fiel BOOLEAN DEFAULT FALSE
    )
  `);

  // Tabela de produtos
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS produtos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      descricao TEXT,
      imagem TEXT,
      categoria VARCHAR(255) DEFAULT 'geral',
      preco DECIMAL(10,2) NOT NULL,
      estoque INT DEFAULT 0,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabela de pedidos
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT NOT NULL,
      data_pedido TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      valor_total DECIMAL(10,2),
      desconto_aplicado DECIMAL(10,2) DEFAULT 0.00,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    )
  `);

  // Tabela de itens de pedido (relacionamento N:N entre pedidos e produtos)
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS pedido_itens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id INT NOT NULL,
      produto_id INT NOT NULL,
      quantidade INT NOT NULL,
      preco_unitario DECIMAL(10,2) NOT NULL,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    )
  `);

  connection.release();
}
init();

// Rota para salvar dado
// Criar usuário
app.post('/usuarios', async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const [result] = await pool.execute(
      'INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)',
      [nome, email, senha]
    );
    res.json({ id: result.insertId, nome, email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: 'Erro ao criar usuário' });
  }
});

// Criar produto
app.post('/produtos', async (req, res) => {
  const { nome, descricao, preco, estoque, imagem, categoria } = req.body;
  console.log(imagem)
  try {
    const [result] = await pool.execute(
    'INSERT INTO produtos (nome, descricao, preco, estoque, imagem, categoria) VALUES (?, ?, ?, ?, ?, ?)',
    [nome, descricao, preco, estoque, imagem, categoria]
  );
    res.json({ id: result.insertId, nome, preco });
  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: 'Erro ao criar produto' });
  }
});

// Criar pedido com itens
app.post('/pedidos', async (req, res) => {
  const { usuario_id, itens } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Verifica se cliente é fiel
    const [[usuario]] = await connection.execute(
      'SELECT total_gasto, cliente_fiel FROM usuarios WHERE id = ?',
      [usuario_id]
    );

    if (!usuario) throw new Error('Usuário não encontrado');

    let valor_total = 0;
    const desconto = usuario.cliente_fiel ? 0.10 : 0.00; // 10% se fiel

    // Cria pedido (sem valor ainda)
    const [pedidoResult] = await connection.execute(
      'INSERT INTO pedidos (usuario_id, valor_total, desconto_aplicado) VALUES (?, 0, 0)',
      [usuario_id]
    );
    const pedido_id = pedidoResult.insertId;

    // Insere itens
    for (const item of itens) {
      const [[produto]] = await connection.execute(
        'SELECT preco FROM produtos WHERE id = ?',
        [item.produto_id]
      );
      if (!produto) throw new Error(`Produto ${item.produto_id} não encontrado`);

      const subtotal = produto.preco * item.quantidade;
      valor_total += subtotal;

      await connection.execute(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES (?, ?, ?, ?)',
        [pedido_id, item.produto_id, item.quantidade, produto.preco]
      );
    }

    const valor_com_desconto = valor_total * (1 - desconto);

    // Atualiza pedido com valor total e desconto
    await connection.execute(
      'UPDATE pedidos SET valor_total = ?, desconto_aplicado = ? WHERE id = ?',
      [valor_com_desconto, valor_total - valor_com_desconto, pedido_id]
    );

    // Atualiza total gasto do usuário
    const novo_total = parseFloat(usuario.total_gasto) + valor_com_desconto;
    const virou_fiel = novo_total >= 1000;

    await connection.execute(
      'UPDATE usuarios SET total_gasto = ?, cliente_fiel = ? WHERE id = ?',
      [novo_total, virou_fiel, usuario_id]
    );

    await connection.commit();
    res.json({ pedido_id, valor_total, desconto_aplicado: valor_total - valor_com_desconto });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ erro: err.message || 'Erro ao criar pedido' });
  } finally {
    connection.release();
  }
});


app.get('/getUsuarios',async(req,res)=>{
  try {
    const [result] = await pool.query('SELECT*FROM usuarios');
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar' });
  }
})

app.get('/getProdutos', cors(), async (req, res) => {
  try {
    const { nome, categoria, preco, descricao } = req.query;

    let query = 'SELECT * FROM produtos WHERE 1=1';
    const params = [];

    if (nome) {
      query += ' AND nome LIKE ?';
      params.push(`%${nome}%`);
    }

    if (categoria) {
      query += ' AND categoria = ?';
      params.push(categoria);
    }

    if (preco) {
      query += ' AND preco <= ?';
      params.push(preco);
    }

    if (descricao) {
      query += ' AND descricao LIKE ?';
      params.push(`%${descricao}%`);
    }

    const [result] = await pool.query(query, params);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar produto' });
  }
});


app.use(express.json());
app.use(cors({
  origin: '*' // ou domínio do seu frontend
}));

app.listen(3000, () => {
  console.log('Servidor rodando na porta 3000');
});
