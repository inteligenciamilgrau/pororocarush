@echo off
setlocal enabledelayedexpansion
title Pororoca Rush

REM ASCII puro de proposito: chcp + caracteres acentuados no meio de um .bat fazem
REM o cmd perder a posicao de leitura do arquivo e engolir comandos.
REM Caminho absoluto no timeout: em alguns shells o timeout do coreutils tem
REM precedencia no PATH e nao entende /t.

set "RAIZ=%~dp0"
set "PORTA=5179"
set "NODE_EXE="
set "ESPERA=%SystemRoot%\System32\timeout.exe"

cd /d "%RAIZ%"

echo.
echo   ==========================================
echo             P O R O R O C A   R U S H
echo                Pororoca do Arari
echo   ==========================================
echo.

REM --- localiza o node -----------------------------------------------------
REM Ordem: variavel de ambiente, node embarcado no projeto, PATH, instalacao
REM padrao do Windows, e por fim qualquer node-*-win-x64 numa pasta "apps"
REM proxima. Nenhum caminho pessoal fica gravado no arquivo.

if defined POROROCA_NODE if exist "%POROROCA_NODE%" set "NODE_EXE=%POROROCA_NODE%"

if not defined NODE_EXE if exist "%RAIZ%node\node.exe" set "NODE_EXE=%RAIZ%node\node.exe"

if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE_EXE (
  for %%D in ("%RAIZ%..\apps" "%RAIZ%..\..\apps" "%RAIZ%..\..\..\apps" "%RAIZ%..\..\..\..\apps") do (
    if not defined NODE_EXE if exist "%%~fD" (
      for /d %%K in ("%%~fD\node-*") do (
        if not defined NODE_EXE if exist "%%~fK\node.exe" set "NODE_EXE=%%~fK\node.exe"
      )
    )
  )
)

if not defined NODE_EXE (
  echo   [ERRO] node.exe nao encontrado.
  echo.
  echo   Instale o Node.js ^(https://nodejs.org^) ou aponte o caminho:
  echo     set POROROCA_NODE=C:\caminho\para\node.exe
  echo.
  echo   Alternativa: copie uma distribuicao portatil do Node para
  echo     %RAIZ%node\
  echo.
  pause
  exit /b 1
)

if not exist "%RAIZ%node_modules\three\build\three.module.js" (
  echo   [ERRO] Dependencias ausentes ^(node_modules\three^).
  echo.
  echo   Rode na pasta do projeto:
  echo     npm install
  echo.
  pause
  exit /b 1
)

REM --- porta ja em uso? ----------------------------------------------------
netstat -ano | findstr /r /c:"LISTENING.*:%PORTA% " >nul 2>&1
if not errorlevel 1 (
  echo   [AVISO] A porta %PORTA% ja esta em uso.
  echo           Abrindo o navegador no servidor que ja esta rodando.
  echo.
  start http://127.0.0.1:%PORTA%/
  "%ESPERA%" /t 3 >nul
  exit /b 0
)

echo   node: %NODE_EXE%
echo.
echo   Controles
echo   ---------
echo     A / D  ou  setas    direcao
echo     W  ou  seta cima    acelerar (e bombear na face)
echo     S  ou  seta baixo   frear
echo     ESPACO              pular / aereo
echo     SHIFT               agachar (entrar no tubo)
echo     Q / E               girar no ar
echo     G                   grab
echo     C                   trocar camera
echo     P                   pausar
echo     R                   voltar pro pocket
echo.
echo   Servidor: http://127.0.0.1:%PORTA%/
echo   Feche esta janela para encerrar o jogo.
echo.

REM Abre o navegador padrao 2s depois, quando o servidor ja subiu.
start /b "" cmd /c ""%ESPERA%" /t 2 ^>nul ^& start http://127.0.0.1:%PORTA%/"

REM Servidor em primeiro plano: fechar a janela mata o servidor.
"%NODE_EXE%" "%RAIZ%tools\serve.mjs" %PORTA%

echo.
echo   Servidor encerrado.
"%ESPERA%" /t 2 >nul
endlocal
