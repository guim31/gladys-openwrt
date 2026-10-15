# OpenWrt

Siga su router o punto de acceso [OpenWrt](https://openwrt.org) desde Gladys,
por su red local: quién está en casa (los teléfonos conectados al Wi-Fi), el
estado del router, el estado y el caudal de la conexión a internet, el Wi-Fi
de invitados. Sin nube, sin cuenta.

La integración habla con el router como LuCI, la interfaz web de OpenWrt:
mediante **ubus por HTTP** (`/ubus`, sesiones rpcd). Un router sin `/ubus`
pero con la API LuCI RPC (luci-mod-rpc) sigue dando la presencia y el tiempo
de funcionamiento.

> **Desarrollada sin el hardware: sus comentarios son bienvenidos.** La
> integración está construida y probada con las respuestas de OpenWrt leídas en
> su código fuente (procd, netifd, hostapd, rpcd), no con un router real.
> Díganos qué funciona y qué no en las
> [issues](https://github.com/guim31/gladys-openwrt/issues).

Este proyecto no está afiliado al proyecto OpenWrt. OpenWrt es una marca de su
propietario.

## Lo que necesita

- Gladys Assistant **5.1.0** o posterior.
- Un router o punto de acceso con **OpenWrt 18.06 o posterior**, con `rpcd` y
  `uhttpd-mod-ubus`. Ambos vienen con LuCI: todas las imágenes estándar los
  tienen. Compruebe en el router: `ls /usr/lib/uhttpd_ubus.so` debe mostrar el
  archivo. Si no: `opkg install rpcd uhttpd-mod-ubus` (`apk add` en OpenWrt
  25), y luego `/etc/init.d/uhttpd restart`.
- Un usuario rpcd para Gladys (abajo). `root` también funciona, pero un
  usuario dedicado que solo puede leer es más seguro.

## Puesta en marcha

### El usuario rpcd y su ACL

1. Conéctese al router por SSH y cree el archivo
   `/usr/share/rpcd/acl.d/gladys.json`. La parte `read` es lo que la
   integración lee; la parte `write` solo sirve para las órdenes (Wi-Fi de
   invitados, reinicio):

   ```json
   {
     "gladys": {
       "description": "Gladys Assistant",
       "read": {
         "ubus": {
           "system": ["board", "info"],
           "network.interface": ["dump"],
           "network.device": ["status"],
           "network.wireless": ["status"],
           "hostapd.*": ["get_clients"],
           "iwinfo": ["assoclist"],
           "luci-rpc": ["getDHCPLeases"],
           "file": ["read"],
           "uci": ["get"]
         },
         "file": { "/tmp/dhcp.leases": ["read"] },
         "uci": ["wireless"]
       },
       "write": {
         "ubus": { "system": ["reboot"], "uci": ["set", "commit"] },
         "uci": ["wireless"]
       }
     }
   }
   ```

2. Cree el login, con su propia contraseña (`uhttpd -m` la convierte en un
   hash: no se guarda en claro):

   ```sh
   uci add rpcd login
   uci set rpcd.@login[-1].username='gladys'
   uci set rpcd.@login[-1].password="$(uhttpd -m 'elija-una-contrasena-larga')"
   uci add_list rpcd.@login[-1].read='gladys'
   uci commit rpcd
   /etc/init.d/rpcd restart
   ```

3. Solo si quiere las órdenes: dé también la parte de escritura al login, con
   `list write 'gladys'` en su sección de `/etc/config/rpcd`, y luego
   `/etc/init.d/rpcd restart`.

Conviene saber: `network.wireless status` y `uci get wireless` pueden mostrar
las claves Wi-Fi a este usuario. La integración solo lee los nombres, los SSID
y la opción `disabled` del Wi-Fi de invitados, no guarda ninguna clave y nunca
escribe una en sus registros. Las líneas `uci` y `file` son opcionales: sin
ellas, no se leen el Wi-Fi de invitados ni las concesiones de un router
antiguo sin `luci-rpc`.

### La configuración

En Gladys, abra la integración y luego **Configuración**:

- **Dirección del router**: la dirección IP del router (`192.168.1.1` por
  defecto), con `:puerto` si su servidor web usa otro puerto.
- **Usar HTTPS**: cifra la contraseña en su red, cuando `luci-ssl` está
  instalado. Un router que redirige HTTP a HTTPS se sigue de todos modos.
- **Aceptar un certificado autofirmado**: OpenWrt crea su propio certificado
  en el primer arranque; márquelo para su propio router.
- **Nombre de usuario** y **Contraseña**: el login rpcd creado arriba.
- **Interfaz**: deje _Automático_ (ubus, y LuCI RPC solo si el router no tiene
  `/ubus`).
- **Intervalo de actualización**: de 10 s a 1 min (30 s por defecto).
- **Interfaces WAN**: vacío, la integración toma `wan` y las interfaces con la
  ruta predeterminada. Si no, los nombres de _Red → Interfaces_ (`wan, wwan`),
  cuatro como máximo.
- **Retardo de salida (minutos)** y **Contar una concesión DHCP como
  presente**: vea los sensores de presencia más abajo.
- **Red Wi-Fi de invitados**: el nombre de la sección `wifi-iface` de la red de
  invitados (`guest`, `wifinet2`…). **Listar las redes Wi-Fi** las muestra.
- **Permitir órdenes**: desactivado por defecto (vea las acciones).
- **Idioma de los nombres**: idioma de los nombres de dispositivos y funciones.

Guarde y haga clic en **Probar la conexión**: el informe dice qué interfaz ha
respondido, las interfaces WAN y las radios encontradas, los clientes vistos y
lo que la ACL no permite.

## Los dispositivos

Abra la pestaña **Descubrir**: allí aparecen el router y los clientes de la
red que ve. Añada los que quiera.

### El router

- **Carga del sistema (1 min)**: la carga media en porcentaje de un núcleo del
  procesador (un router con 4 núcleos ocupados muestra 400 %).
- **Memoria usada**, en porcentaje.
- **Tiempo de funcionamiento**, en horas.
- **Versión de OpenWrt** (`23.05.5`).
- **Clientes Wi-Fi** por radio (`Clientes Wi-Fi 2.4 GHz`, `5 GHz`…): las
  estaciones conectadas y autorizadas.
- **Wi-Fi de invitados activado**, cuando se elige una red de invitados.
- Para cada interfaz WAN: caudal de **Descarga** y de **Subida** (Mbit/s, el
  promedio sobre el intervalo de actualización) y **Enlace WAN** (1 cuando está
  activo).

Nada en estos dispositivos es un interruptor: un asistente de voz no puede
apagar el Wi-Fi de invitados ni reiniciar el router por error.

### Sensores de presencia

Cada cliente añadido se convierte en un sensor de **Presencia**: presente
mientras está conectado (y autorizado) al Wi-Fi del router, ausente cuando no
se ha visto durante el **retardo de salida** (5 minutos por defecto): un
teléfono en reposo deja el Wi-Fi unos minutos.

- Un router que no se puede leer no cambia a nadie: una avería nunca deja a
  toda la casa ausente.
- Los dispositivos con cable no están en el Wi-Fi: marque **Contar una
  concesión DHCP como presente** para ellos, sabiendo que una concesión dura
  hasta que caduca (12 h por defecto).
- Los teléfonos usan una dirección MAC privada (aleatoria) por red Wi-Fi: siga
  la dirección que el teléfono usa en su red y manténgala fija en sus ajustes
  Wi-Fi.

## Panel de control

- **Router OpenWrt**: carga, memoria, caudal del primer WAN, clientes Wi-Fi,
  estado de cada enlace WAN, de cada radio y del Wi-Fi de invitados, tiempo de
  funcionamiento y versión. Con las órdenes permitidas: un botón **Wi-Fi de
  invitados** (su icono muestra el estado actual) y un botón **Reiniciar**,
  ambos con confirmación.
- **Dispositivos en casa**: los dispositivos seguidos, presentes primero, con
  el tiempo desde una salida; un ajuste muestra solo los presentes.

## Escenas

### Disparadores

- **Dispositivo desconocido conectado**: una dirección MAC nunca vista se ha
  unido al Wi-Fi o ha obtenido una concesión DHCP. La primera lectura aprende
  la red tal como está; las direcciones vistas se guardan en `/data`. Filtros:
  **Visto por** (Wi-Fi o concesión DHCP) y **Red Wi-Fi (SSID)**. Variables:
  dirección MAC, dirección IP, nombre de host, SSID, interfaz Wi-Fi.
- **Enlace WAN cortado**: una interfaz WAN ha caído. Filtro: **Interfaz WAN
  (p. ej. wan)**.
- **Enlace WAN restablecido**: vuelve a estar activa; la variable _Duración
  del corte (minutos)_ da la duración del corte.

### Acciones

Las acciones no hacen nada mientras **Permitir órdenes** no esté marcado, y el
router las rechaza si la ACL no tiene parte de escritura.

- **Encender el Wi-Fi de invitados** y **Apagar el Wi-Fi de invitados**:
  cambian la opción `disabled` de la sección elegida y la confirman; OpenWrt
  recarga el Wi-Fi (las demás redes parpadean unos segundos). La salida indica
  si el Wi-Fi de invitados está activado.
- **Reiniciar el router OpenWrt**: la red se corta de uno a tres minutos.

### Ideas de escenas

- Llegan invitados: el sábado a las 18 h, **Encender el Wi-Fi de invitados**;
  a la 1 h, **Apagar el Wi-Fi de invitados**.
- Nadie en casa: cuando los sensores de presencia de los teléfonos están todos
  ausentes, active la alarma y baje la calefacción.
- **Dispositivo desconocido conectado** en su SSID principal: envíe un mensaje
  con la dirección MAC y el nombre de host.
- **Enlace WAN restablecido** tras más de 10 minutos: envíese la duración del
  corte.

## Con qué frecuencia se lee el router

En cada intervalo de actualización, la integración llama a `system info`,
`network.interface dump`, `network.device status`, `network.wireless status`,
al `get_clients` de cada punto de acceso (o `iwinfo assoclist`) y a las
concesiones DHCP: una decena de pequeñas peticiones, solo de lectura, en su
red local. Gladys no consulta estos dispositivos: el temporizador es el de la
integración. Solo se envían a Gladys los valores que cambian, con un reenvío
cada seis horas.

## Solución de problemas

- **«ni ubus ni LuCI RPC aquí»**: instale `uhttpd-mod-ubus` (vea arriba), o
  compruebe la dirección y el puerto.
- **«nombre de usuario o contraseña rechazados por rpcd»**: compruebe el login
  en `/etc/config/rpcd` y reinicie rpcd. Tras un rechazo, la integración espera
  cinco minutos antes de reintentar: haga clic en **Probar la conexión** para
  reintentar ya.
- **«rechazado por la ACL rpcd»**: el archivo de la ACL falta o no nombra el
  login (`list read 'gladys'`); el informe enumera lo que no se puede leer.
- **«certificado rechazado»**: marque **Aceptar un certificado autofirmado**.
- **Ningún cliente Wi-Fi**: los puntos de acceso necesitan `hostapd.*` en la
  ACL; con un hostapd compilado sin ubus, `rpcd-mod-iwinfo` debe estar
  instalado.
- Registros: ponga `LOG_LEVEL=debug` en el contenedor para el detalle de cada
  lectura (nunca una contraseña ni una clave Wi-Fi).

## Límites

- Un router por integración: los clientes de otros puntos de acceso no se ven
  en su Wi-Fi (la opción de concesión DHCP los ve de todos modos).
- El enlace WAN es el estado de la interfaz: un corte detrás de un enlace
  activo (del lado del operador) no se ve. Los caudales son promedios sobre el
  intervalo.
- El Wi-Fi de invitados es una sección `wifi-iface`, nombrada en la
  configuración; OpenWrt no lista una red desactivada (escriba su nombre).
- Alternativa LuCI RPC: presencia por la tabla de vecinos (menos precisa que
  el Wi-Fi), tiempo de funcionamiento y reinicio solamente; sin disparador de
  dispositivo desconocido.
- Desarrollada sin el hardware: la confirmación del Wi-Fi de invitados, el
  reinicio y la alternativa LuCI RPC no están probados en un router real.
