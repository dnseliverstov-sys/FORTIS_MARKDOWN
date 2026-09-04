import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider, Toaster, ToasterComponent, ToasterProvider} from '@gravity-ui/uikit';
import * as katexRuntime from 'katex';
import '@gravity-ui/uikit/styles/styles.css';
import 'katex/dist/katex.min.css';
import '@diplodoc/transform/dist/css/yfm.css';
import '@gravity-ui/markdown-editor/styles/yfm-themes.css';
import './styles.css';
import App from './App';
import {configure as configureMarkdownEditor} from '@gravity-ui/markdown-editor';

window.katex = katexRuntime;
configureMarkdownEditor({lang: 'ru'});
const toaster = new Toaster();
const root = document.getElementById('root');

if (!root) throw new Error('Не найден корневой элемент приложения');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme="dark" lang="ru">
      <ToasterProvider toaster={toaster}>
        <App />
        <ToasterComponent />
      </ToasterProvider>
    </ThemeProvider>
  </StrictMode>,
);
