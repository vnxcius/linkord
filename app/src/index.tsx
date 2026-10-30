import { render } from 'solid-js/web';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import App from './App';
import { pickReachableServer } from './lib/api';
import { installContextMenu } from './lib/contextmenu';
import { installErrorReporting } from './lib/report';

installContextMenu();
installErrorReporting();

// The desktop app may need the direct address before anything connects (ISPs that block Cloudflare).
void pickReachableServer().then(() => render(() => <App />, document.getElementById('root')!));
