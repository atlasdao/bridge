# Atlas Bridge

**Ferramentas para Soberania Financeira Individual**

## Introdução

O Atlas Bridge é uma iniciativa da [Atlas DAO](https://atlasdao.info) dedicada ao desenvolvimento de software de código aberto que capacita indivíduos com maior controle e autonomia sobre seus ativos financeiros e propriedades. O projeto adere a princípios de minimização de confiança, transparência e resistência à censura, buscando fornecer alternativas robustas aos sistemas tradicionais.

Este documento descreve o "Atlas Bridge", o primeiro produto desenvolvido sob esta iniciativa.

## Visão Geral do Produto: Atlas Bridge

O Atlas Bridge serve como uma interface programática entre o sistema de pagamentos instantâneos brasileiro, Pix, e a Liquid Network, uma sidechain do Bitcoin. O objetivo primário é facilitar a interação entre o Real Brasileiro (BRL) e ativos digitais que promovem a soberania do usuário, como o DePix (um Real sintético na Liquid Network).

### Versão Atual: Alfa

O software encontra-se em estágio Alfa de desenvolvimento mas já em fase operacional.

### Funcionalidade Principal (MVP Alfa):

*   **Conversão de Pix para DePix (Entrada):**
    Usuários (comerciantes ou indivíduos) podem gerar cobranças Pix através do Atlas Bridge. Ao receber um pagamento Pix, o valor correspondente é convertido para tokens DePix (real sintético pareado 1:1 com o BRL) e creditado diretamente na carteira Liquid não custodial do usuário. Este processo visa oferecer:
    *   **Autocustódia:** Os fundos DePix são controlados exclusivamente pelo usuário.
    *   **Estabilidade:** O DePix é pareado 1:1 com o BRL.
    *   **Interoperabilidade:** Permite a posterior conversão de DePix para L-BTC e, subsequentemente, Bitcoin (BTC) on-chain.

## Filosofia e Princípios de Design

O desenvolvimento do Atlas Bridge é guiado pelos seguintes princípios fundamentais:

*   **Soberania do Usuário:** O controle sobre as chaves privadas e, consequentemente, os fundos, deve permanecer com o usuário no modelo não custodial.
*   **Minimização de Confiança:** A arquitetura é projetada para reduzir a dependência de intermediários, incluindo a própria Atlas DAO, na medida do tecnicamente possível.
*   **Código Aberto (GPLv3):** Todo o código fonte é publicado sob a licença GNU General Public License v3.0, garantindo as liberdades de usar, estudar, modificar e distribuir o software.
*   **Transparência e Auditabilidade:** As operações e o código fonte são públicos, permitindo escrutínio e auditoria pela comunidade.
*   **Resistência à Censura:** O design visa maximizar a resiliência contra tentativas de bloqueio de transações ou acesso de usuários.

## Instruções de Uso (MVP Alfa - Bot Telegram)

A interação com a versão Alfa do Atlas Bridge é realizada através de um bot na plataforma Telegram.

1.  **Acesso ao Bot:** Inicie uma conversa com o bot oficial: https://t.me/atlas_bridge_bot
2.  **Configuração de Carteira:** Siga as instruções para associar um endereço de carteira da Liquid Network. O Atlas Bridge opera de forma não custodial; o bot não armazena chaves privadas.
3.  **Geração de Cobranças Pix:** Utilize a funcionalidade para gerar QR Codes Pix e receber pagamentos em DePix.

## Roteiro de Desenvolvimento (Futuras Funcionalidades)

O desenvolvimento do Atlas Bridge é contínuo. As funcionalidades planejadas para futuras versões incluem, mas não se limitam a:

*   **Suporte a DePix na Lightning Network:** Utilização de DePix via Taproot Assets na Lightning Network do Bitcoin para transações mais rápidas e com taxas reduzidas.
*   **Pagamentos Pix com DePix (Saída):** Capacidade de utilizar saldo DePix para realizar pagamentos para qualquer chave ou QR Code Pix.
*   **Opções de "Top-up" Ampliadas:** Adicionar saldo DePix utilizando Bitcoin (on-chain e Lightning Network) e Monero.
*   **Modo Custodial Opcional:** Uma alternativa para usuários iniciantes que preferem não gerenciar chaves privadas inicialmente, com um caminho claro para a autocustódia.

## Contribuições e Comunidade

O Atlas Bridge é um projeto orientado pela comunidade. Encorajamos a participação ativa em todas as frentes:

*   **Comunidade Telegram:** Junte-se ao nosso grupo principal para discussões, suporte, e para acompanhar o desenvolvimento: [https://t.me/+x0no8ursVlZhOTI5](https://t.me/+x0no8ursVlZhOTI5)
*   **Desenvolvimento de Código:** Contribuições para o código fonte são bem-vindas. Consulte o repositório GitHub, verifique as *Issues* abertas ou proponha novas melhorias através de *Pull Requests*.
*   **Relato de Bugs e Sugestões:** Utilize a seção de *Issues* do repositório GitHub para relatar problemas ou sugerir novas funcionalidades.
*   **Outras Formas de Contribuição:** Ideias, feedback, design, marketing, documentação e apoio financeiro são formas valiosas de contribuir para o avanço do projeto.

## Apoio ao Projeto (Doações)

A Atlas DAO opera como uma Organização Autônoma Descentralizada. O financiamento para o desenvolvimento, manutenção da infraestrutura e custos operacionais depende primariamente de doações da comunidade.

*   **Endereço Liquid para doações (DePix ou L-BTC):**
    `VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX`

## Licença

Este software é distribuído sob os termos da **GNU General Public License v3.0 (GPLv3)**. Uma cópia completa da licença pode ser encontrada no arquivo `LICENSE` neste repositório.

---

O Atlas Bridge visa ser uma ferramenta fundamental na busca pela autonomia financeira. Sua participação e feedback são essenciais para o sucesso desta missão.
